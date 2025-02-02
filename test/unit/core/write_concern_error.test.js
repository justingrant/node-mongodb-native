'use strict';
const { Topology } = require('../../../src/sdam/topology');
const mock = require('../../tools/mock');
const { ReplSetFixture } = require('./common');
const { MongoWriteConcernError } = require('../../../src/error');
const { expect } = require('chai');
const { ns } = require('../../../src/utils');
const { once } = require('events');
const { MongoServerError } = require('../../../src');

describe('WriteConcernError', function () {
  let test;
  const RAW_USER_WRITE_CONCERN_CMD = {
    createUser: 'foo2',
    pwd: 'pwd',
    roles: ['read'],
    writeConcern: { w: 'majority', wtimeoutMS: 1 }
  };

  const RAW_USER_WRITE_CONCERN_ERROR = {
    ok: 0,
    errmsg: 'waiting for replication timed out',
    code: 64,
    codeName: 'WriteConcernFailed',
    writeConcernError: {
      code: 64,
      codeName: 'WriteConcernFailed',
      errmsg: 'waiting for replication timed out',
      errInfo: {
        wtimeout: true
      }
    }
  };

  const RAW_USER_WRITE_CONCERN_ERROR_INFO = {
    ok: 0,
    errmsg: 'waiting for replication timed out',
    code: 64,
    codeName: 'WriteConcernFailed',
    writeConcernError: {
      code: 64,
      codeName: 'WriteConcernFailed',
      errmsg: 'waiting for replication timed out',
      errInfo: {
        writeConcern: {
          w: 2,
          wtimeout: 0,
          provenance: 'clientSupplied'
        }
      }
    }
  };

  before(() => (test = new ReplSetFixture()));
  afterEach(() => mock.cleanup());
  beforeEach(() => test.setup());

  function makeAndConnectReplSet(cb) {
    let invoked = false;
    const replSet = new Topology(
      [test.primaryServer.hostAddress(), test.firstSecondaryServer.hostAddress()],
      { replicaSet: 'rs' }
    );

    replSet.once('error', err => {
      if (invoked) {
        return;
      }
      invoked = true;
      cb(err);
    });

    replSet.on('connect', () => {
      if (invoked) {
        return;
      }

      invoked = true;
      cb(undefined, replSet);
    });

    replSet.connect();
  }

  it('should expose a user command writeConcern error like a normal WriteConcernError', function (done) {
    test.primaryServer.setMessageHandler(request => {
      const doc = request.document;
      if (doc.ismaster || doc.hello) {
        setTimeout(() => request.reply(test.primaryStates[0]));
      } else if (doc.createUser) {
        setTimeout(() => request.reply(RAW_USER_WRITE_CONCERN_ERROR));
      }
    });

    makeAndConnectReplSet((err, topology) => {
      // cleanup the server before calling done
      const cleanup = err => topology.close({ force: true }, err2 => done(err || err2));

      if (err) {
        return cleanup(err);
      }

      topology.selectServer('primary', (err, server) => {
        expect(err).to.not.exist;

        server.command(ns('db1'), Object.assign({}, RAW_USER_WRITE_CONCERN_CMD), err => {
          let _err;
          try {
            expect(err).to.be.an.instanceOf(MongoWriteConcernError);
            expect(err.result).to.exist;
            expect(err.result).to.have.property('ok', 1);
            expect(err.result).to.not.have.property('errmsg');
            expect(err.result).to.not.have.property('code');
            expect(err.result).to.not.have.property('codeName');
            expect(err.result).to.have.property('writeConcernError');
          } catch (e) {
            _err = e;
          } finally {
            cleanup(_err);
          }
        });
      });
    });
  });

  it('should propagate writeConcernError.errInfo ', function (done) {
    test.primaryServer.setMessageHandler(request => {
      const doc = request.document;
      if (doc.ismaster || doc.hello) {
        setTimeout(() => request.reply(test.primaryStates[0]));
      } else if (doc.createUser) {
        setTimeout(() => request.reply(RAW_USER_WRITE_CONCERN_ERROR_INFO));
      }
    });

    makeAndConnectReplSet((err, topology) => {
      // cleanup the server before calling done
      const cleanup = err => topology.close(err2 => done(err || err2));

      if (err) {
        return cleanup(err);
      }

      topology.selectServer('primary', (err, server) => {
        expect(err).to.not.exist;

        server.command(ns('db1'), Object.assign({}, RAW_USER_WRITE_CONCERN_CMD), err => {
          let _err;
          try {
            expect(err).to.be.an.instanceOf(MongoWriteConcernError);
            expect(err.result).to.exist;
            expect(err.result.writeConcernError).to.deep.equal(
              RAW_USER_WRITE_CONCERN_ERROR_INFO.writeConcernError
            );
          } catch (e) {
            _err = e;
          } finally {
            cleanup(_err);
          }
        });
      });
    });
  });

  describe('errInfo property', () => {
    let client;

    beforeEach(async function () {
      client = this.configuration.newClient({ monitorCommands: true });
      await client.connect();
    });

    afterEach(async () => {
      if (client) {
        await client.close();
        client.removeAllListeners();
      }
    });

    it('should always be accessible', {
      metadata: { requires: { mongodb: '>=5.0.0' } },
      async test() {
        try {
          await client.db().collection('wc_details').drop();
        } catch {
          // don't care
        }

        const collection = await client
          .db()
          .createCollection('wc_details', { validator: { x: { $type: 'string' } } });

        const evCapture = once(client, 'commandSucceeded');

        let errInfoFromError;
        try {
          await collection.insertOne({ x: /not a string/ });
          expect.fail('The insert should fail the validation that x must be a string');
        } catch (error) {
          expect(error).to.be.instanceOf(MongoServerError);
          expect(error).to.have.property('code', 121);
          expect(error).to.have.property('errInfo').that.is.an('object');
          errInfoFromError = error.errInfo;
        }

        const commandSucceededEvents = await evCapture;
        expect(commandSucceededEvents).to.have.lengthOf(1);
        const ev = commandSucceededEvents[0];
        expect(ev).to.have.nested.property('reply.writeErrors[0].errInfo').that.is.an('object');

        const errInfoFromEvent = ev.reply.writeErrors[0].errInfo;
        expect(errInfoFromError).to.deep.equal(errInfoFromEvent);
      }
    });
  });
});
