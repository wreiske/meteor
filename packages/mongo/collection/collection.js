import { normalizeProjection } from "../mongo_utils";
import { AsyncMethods } from './methods_async';
import { SyncMethods } from './methods_sync';

/**
 * @summary Namespace for MongoDB-related items
 * @namespace
 */
Mongo = {};

/**
 * @summary Constructor for a Collection
 * @locus Anywhere
 * @instancename collection
 * @class
 * @param {String} name The name of the collection.  If null, creates an unmanaged (unsynchronized) local collection.
 * @param {Object} [options]
 * @param {Object} options.connection The server connection that will manage this collection. Uses the default connection if not specified.  Pass the return value of calling [`DDP.connect`](#DDP-connect) to specify a different server. Pass `null` to specify no connection. Unmanaged (`name` is null) collections cannot specify a connection.
 * @param {String} options.idGeneration The method of generating the `_id` fields of new documents in this collection.  Possible values:

 - **`'STRING'`**: random strings
 - **`'MONGO'`**:  random [`Mongo.ObjectID`](#mongo_object_id) values

The default id generation technique is `'STRING'`.
 * @param {Function} options.transform An optional transformation function. Documents will be passed through this function before being returned from `fetch` or `findOneAsync`, and before being passed to callbacks of `observe`, `map`, `forEach`, `allow`, and `deny`. Transforms are *not* applied for the callbacks of `observeChanges` or to cursors returned from publish functions.
 * @param {Boolean} options.defineMutationMethods Set to `false` to skip setting up the mutation methods that enable insert/update/remove from client code. Default `true`.
 */
Mongo.Collection = function Collection(name, options) {
  if (!name && name !== null) {
    Meteor._debug(
      'Warning: creating anonymous collection. It will not be ' +
        'saved or synchronized over the network. (Pass null for ' +
        'the collection name to turn off this warning.)'
    );
    name = null;
  }

  if (name !== null && typeof name !== 'string') {
    throw new Error(
      'First argument to new Mongo.Collection must be a string or null'
    );
  }

  if (options && options.methods) {
    // Backwards compatibility hack with original signature (which passed
    // "connection" directly instead of in options. (Connections must have a "methods"
    // method.)
    // XXX remove before 1.0
    options = { connection: options };
  }
  // Backwards compatibility: "connection" used to be called "manager".
  if (options && options.manager && !options.connection) {
    options.connection = options.manager;
  }

  options = {
    connection: undefined,
    idGeneration: 'STRING',
    transform: null,
    _driver: undefined,
    _preventAutopublish: false,
    ...options,
  };

  switch (options.idGeneration) {
    case 'MONGO':
      this._makeNewID = function() {
        var src = name
          ? DDP.randomStream('/collection/' + name)
          : Random.insecure;
        return new Mongo.ObjectID(src.hexString(24));
      };
      break;
    case 'STRING':
    default:
      this._makeNewID = function() {
        var src = name
          ? DDP.randomStream('/collection/' + name)
          : Random.insecure;
        return src.id();
      };
      break;
  }

  this._transform = LocalCollection.wrapTransform(options.transform);

  this.resolverType = options.resolverType;

  if (!name || options.connection === null)
    // note: nameless collections never have a connection
    this._connection = null;
  else if (options.connection) this._connection = options.connection;
  else if (Meteor.isClient) this._connection = Meteor.connection;
  else this._connection = Meteor.server;

  if (!options._driver) {
    // XXX This check assumes that webapp is loaded so that Meteor.server !==
    // null. We should fully support the case of "want to use a Mongo-backed
    // collection from Node code without webapp", but we don't yet.
    // #MeteorServerNull
    if (
      name &&
      this._connection === Meteor.server &&
      typeof MongoInternals !== 'undefined' &&
      MongoInternals.defaultRemoteCollectionDriver
    ) {
      options._driver = MongoInternals.defaultRemoteCollectionDriver();
    } else {
      const { LocalCollectionDriver } = require('../local_collection_driver.js');
      options._driver = LocalCollectionDriver;
    }
  }

  this._collection = options._driver.open(name, this._connection);
  this._name = name;
  this._driver = options._driver;

  // TODO[fibers]: _maybeSetUpReplication is now async. Let's watch how not waiting for this function to finish
    // will affect everything
  this._settingUpReplicationPromise = this._maybeSetUpReplication(name, options);

  // XXX don't define these until allow or deny is actually used for this
  // collection. Could be hard if the security rules are only defined on the
  // server.
  if (options.defineMutationMethods !== false) {
    try {
      this._defineMutationMethods({
        useExisting: options._suppressSameNameError === true,
      });
    } catch (error) {
      // Throw a more understandable error on the server for same collection name
      if (
        error.message === `A method named '/${name}/insertAsync' is already defined`
      )
        throw new Error(`There is already a collection named "${name}"`);
      throw error;
    }
  }

  // autopublish
  if (
    Package.autopublish &&
    !options._preventAutopublish &&
    this._connection &&
    this._connection.publish
  ) {
    this._connection.publish(null, () => this.find(), {
      is_auto: true,
    });
  }

  Mongo._collections.set(this._name, this);
};

Object.assign(Mongo.Collection.prototype, {
  async _maybeSetUpReplication(name) {
    const self = this;
    if (
      !(
        self._connection &&
        self._connection.registerStoreClient &&
        self._connection.registerStoreServer
      )
    ) {
      return;
    }


    const wrappedStoreCommon = {
      // Called around method stub invocations to capture the original versions
      // of modified documents.
      saveOriginals() {
        self._collection.saveOriginals();
      },
      retrieveOriginals() {
        return self._collection.retrieveOriginals();
      },
      // To be able to get back to the collection from the store.
      _getCollection() {
        return self;
      },
    };
    const wrappedStoreClient = {
      // Called at the beginning of a batch of updates. batchSize is the number
      // of update calls to expect.
      //
      // XXX This interface is pretty janky. reset probably ought to go back to
      // being its own function, and callers shouldn't have to calculate
      // batchSize. The optimization of not calling pause/remove should be
      // delayed until later: the first call to update() should buffer its
      // message, and then we can either directly apply it at endUpdate time if
      // it was the only update, or do pauseObservers/apply/apply at the next
      // update() if there's another one.
      async beginUpdate(batchSize, reset) {
        // pause observers so users don't see flicker when updating several
        // objects at once (including the post-reconnect reset-and-reapply
        // stage), and so that a re-sorting of a query can take advantage of the
        // full _diffQuery moved calculation instead of applying change one at a
        // time.
        if (batchSize > 1 || reset) self._collection.pauseObservers();

        if (reset) await self._collection.remove({});
      },

      // Apply an update.
      // XXX better specify this interface (not in terms of a wire message)?
      update(msg) {
        var mongoId = MongoID.idParse(msg.id);
        var doc = self._collection._docs.get(mongoId);

        //When the server's mergebox is disabled for a collection, the client must gracefully handle it when:
        // *We receive an added message for a document that is already there. Instead, it will be changed
        // *We reeive a change message for a document that is not there. Instead, it will be added
        // *We receive a removed messsage for a document that is not there. Instead, noting wil happen.

        //Code is derived from client-side code originally in peerlibrary:control-mergebox
        //https://github.com/peerlibrary/meteor-control-mergebox/blob/master/client.coffee

        //For more information, refer to discussion "Initial support for publication strategies in livedata server":
        //https://github.com/meteor/meteor/pull/11151
        if (Meteor.isClient) {
          if (msg.msg === 'added' && doc) {
            msg.msg = 'changed';
          } else if (msg.msg === 'removed' && !doc) {
            return;
          } else if (msg.msg === 'changed' && !doc) {
            msg.msg = 'added';
            const _ref = msg.fields;
            for (let field in _ref) {
              const value = _ref[field];
              if (value === void 0) {
                delete msg.fields[field];
              }
            }
          }
        }
        // Is this a "replace the whole doc" message coming from the quiescence
        // of method writes to an object? (Note that 'undefined' is a valid
        // value meaning "remove it".)
        if (msg.msg === 'replace') {
          var replace = msg.replace;
          if (!replace) {
            if (doc) self._collection.remove(mongoId);
          } else if (!doc) {
            self._collection.insert(replace);
          } else {
            // XXX check that replace has no $ ops
            self._collection.update(mongoId, replace);
          }
          return;
        } else if (msg.msg === 'added') {
          if (doc) {
            throw new Error(
              'Expected not to find a document already present for an add'
            );
          }
          self._collection.insert({ _id: mongoId, ...msg.fields });
        } else if (msg.msg === 'removed') {
          if (!doc)
            throw new Error(
              'Expected to find a document already present for removed'
            );
          self._collection.remove(mongoId);
        } else if (msg.msg === 'changed') {
          if (!doc) throw new Error('Expected to find a document to change');
          const keys = Object.keys(msg.fields);
          if (keys.length > 0) {
            var modifier = {};
            keys.forEach(key => {
              const value = msg.fields[key];
              if (EJSON.equals(doc[key], value)) {
                return;
              }
              if (typeof value === 'undefined') {
                if (!modifier.$unset) {
                  modifier.$unset = {};
                }
                modifier.$unset[key] = 1;
              } else {
                if (!modifier.$set) {
                  modifier.$set = {};
                }
                modifier.$set[key] = value;
              }
            });
            if (Object.keys(modifier).length > 0) {
              self._collection.update(mongoId, modifier);
            }
          }
        } else {
          throw new Error("I don't know how to deal with this message");
        }
      },

      // Called at the end of a batch of updates.livedata_connection.js:1287
      endUpdate() {
        self._collection.resumeObserversClient();
      },

      // Used to preserve current versions of documents across a store reset.
      getDoc(id) {
        return self.findOne(id);
      },

      ...wrappedStoreCommon,
    };
    const wrappedStoreServer = {
      async beginUpdate(batchSize, reset) {
        if (batchSize > 1 || reset) self._collection.pauseObservers();

        if (reset) await self._collection.removeAsync({});
      },

      async update(msg) {
        var mongoId = MongoID.idParse(msg.id);
        var doc = self._collection._docs.get(mongoId);

        // Is this a "replace the whole doc" message coming from the quiescence
        // of method writes to an object? (Note that 'undefined' is a valid
        // value meaning "remove it".)
        if (msg.msg === 'replace') {
          var replace = msg.replace;
          if (!replace) {
            if (doc) await self._collection.removeAsync(mongoId);
          } else if (!doc) {
            await self._collection.insertAsync(replace);
          } else {
            // XXX check that replace has no $ ops
            await self._collection.updateAsync(mongoId, replace);
          }
          return;
        } else if (msg.msg === 'added') {
          if (doc) {
            throw new Error(
              'Expected not to find a document already present for an add'
            );
          }
          await self._collection.insertAsync({ _id: mongoId, ...msg.fields });
        } else if (msg.msg === 'removed') {
          if (!doc)
            throw new Error(
              'Expected to find a document already present for removed'
            );
          await self._collection.removeAsync(mongoId);
        } else if (msg.msg === 'changed') {
          if (!doc) throw new Error('Expected to find a document to change');
          const keys = Object.keys(msg.fields);
          if (keys.length > 0) {
            var modifier = {};
            keys.forEach(key => {
              const value = msg.fields[key];
              if (EJSON.equals(doc[key], value)) {
                return;
              }
              if (typeof value === 'undefined') {
                if (!modifier.$unset) {
                  modifier.$unset = {};
                }
                modifier.$unset[key] = 1;
              } else {
                if (!modifier.$set) {
                  modifier.$set = {};
                }
                modifier.$set[key] = value;
              }
            });
            if (Object.keys(modifier).length > 0) {
              await self._collection.updateAsync(mongoId, modifier);
            }
          }
        } else {
          throw new Error("I don't know how to deal with this message");
        }
      },

      // Called at the end of a batch of updates.
      async endUpdate() {
        await self._collection.resumeObserversServer();
      },

      // Used to preserve current versions of documents across a store reset.
      async getDoc(id) {
        return self.findOneAsync(id);
      },
      ...wrappedStoreCommon,
    };


    // OK, we're going to be a slave, replicating some remote
    // database, except possibly with some temporary divergence while
    // we have unacknowledged RPC's.
    let registerStoreResult;
    if (Meteor.isClient) {
      registerStoreResult = self._connection.registerStoreClient(
        name,
        wrappedStoreClient
      );
    } else {
      registerStoreResult = self._connection.registerStoreServer(
        name,
        wrappedStoreServer
      );
    }

    const message = `There is already a collection named "${name}"`;
    const logWarn = () => {
      console.warn ? console.warn(message) : console.log(message);
    };

    if (!registerStoreResult) {
      return logWarn();
    }

    return registerStoreResult?.then?.(ok => {
      if (!ok) {
        logWarn();
      }
    });
  },

  ///
  /// Main collection API
  ///
  /**
   * @summary Gets the number of documents matching the filter. For a fast count of the total documents in a collection see `estimatedDocumentCount`.
   * @locus Anywhere
   * @method countDocuments
   * @memberof Mongo.Collection
   * @instance
   * @param {MongoSelector} [selector] A query describing the documents to count
   * @param {Object} [options] All options are listed in [MongoDB documentation](https://mongodb.github.io/node-mongodb-native/4.11/interfaces/CountDocumentsOptions.html). Please note that not all of them are available on the client.
   * @returns {Promise<number>}
   */
  countDocuments(...args) {
    return this._collection.countDocuments(...args);
  },

  /**
   * @summary Gets an estimate of the count of documents in a collection using collection metadata. For an exact count of the documents in a collection see `countDocuments`.
   * @locus Anywhere
   * @method estimatedDocumentCount
   * @memberof Mongo.Collection
   * @instance
   * @param {Object} [options] All options are listed in [MongoDB documentation](https://mongodb.github.io/node-mongodb-native/4.11/interfaces/EstimatedDocumentCountOptions.html). Please note that not all of them are available on the client.
   * @returns {Promise<number>}
   */
  estimatedDocumentCount(...args) {
    return this._collection.estimatedDocumentCount(...args);
  },

  _getFindSelector(args) {
    if (args.length == 0) return {};
    else return args[0];
  },

  _getFindOptions(args) {
    const [, options] = args || [];
    const newOptions = normalizeProjection(options);

    var self = this;
    if (args.length < 2) {
      return { transform: self._transform };
    } else {
      check(
        newOptions,
        Match.Optional(
          Match.ObjectIncluding({
            projection: Match.Optional(Match.OneOf(Object, undefined)),
            sort: Match.Optional(
              Match.OneOf(Object, Array, Function, undefined)
            ),
            limit: Match.Optional(Match.OneOf(Number, undefined)),
            skip: Match.Optional(Match.OneOf(Number, undefined)),
          })
        )
      );

      return {
        transform: self._transform,
        ...newOptions,
      };
    }
  },




});

Object.assign(Mongo.Collection, {
  async _publishCursor(cursor, sub, collection) {
    var observeHandle = await cursor.observeChanges(
        {
          added: function(id, fields) {
            sub.added(collection, id, fields);
          },
          changed: function(id, fields) {
            sub.changed(collection, id, fields);
          },
          removed: function(id) {
            sub.removed(collection, id);
          },
        },
        // Publications don't mutate the documents
        // This is tested by the `livedata - publish callbacks clone` test
        { nonMutatingCallbacks: true }
    );

    // We don't call sub.ready() here: it gets called in livedata_server, after
    // possibly calling _publishCursor on multiple returned cursors.

    // register stop callback (expects lambda w/ no args).
    sub.onStop(async function() {
      return await observeHandle.stop();
    });

    // return the observeHandle in case it needs to be stopped early
    return observeHandle;
  },

  // protect against dangerous selectors.  falsey and {_id: falsey} are both
  // likely programmer error, and not what you want, particularly for destructive
  // operations. If a falsey _id is sent in, a new string _id will be
  // generated and returned; if a fallbackId is provided, it will be returned
  // instead.
  _rewriteSelector(selector, { fallbackId } = {}) {
    // shorthand -- scalars match _id
    if (LocalCollection._selectorIsId(selector)) selector = { _id: selector };

    if (Array.isArray(selector)) {
      // This is consistent with the Mongo console itself; if we don't do this
      // check passing an empty array ends up selecting all items
      throw new Error("Mongo selector can't be an array.");
    }

    if (!selector || ('_id' in selector && !selector._id)) {
      // can't match anything
      return { _id: fallbackId || Random.id() };
    }

    return selector;
  },
});

Object.assign(Mongo.Collection.prototype, SyncMethods);
Object.assign(Mongo.Collection.prototype, AsyncMethods);

Object.assign(Mongo.Collection.prototype, {

  // Determine if this collection is simply a minimongo representation of a real
  // database on another server
  _isRemoteCollection() {
    // XXX see #MeteorServerNull
    return this._connection && this._connection !== Meteor.server;
  },






  // We'll actually design an index API later. For now, we just pass through to
  // Mongo's, but make it synchronous.
  /**
   * @summary Asynchronously creates the specified index on the collection.
   * @locus server
   * @method ensureIndexAsync
   * @deprecated in 3.0
   * @memberof Mongo.Collection
   * @instance
   * @param {Object} index A document that contains the field and value pairs where the field is the index key and the value describes the type of index for that field. For an ascending index on a field, specify a value of `1`; for descending index, specify a value of `-1`. Use `text` for text indexes.
   * @param {Object} [options] All options are listed in [MongoDB documentation](https://docs.mongodb.com/manual/reference/method/db.collection.createIndex/#options)
   * @param {String} options.name Name of the index
   * @param {Boolean} options.unique Define that the index values must be unique, more at [MongoDB documentation](https://docs.mongodb.com/manual/core/index-unique/)
   * @param {Boolean} options.sparse Define that the index is sparse, more at [MongoDB documentation](https://docs.mongodb.com/manual/core/index-sparse/)
   */
  async ensureIndexAsync(index, options) {
    var self = this;
    if (!self._collection.ensureIndexAsync || !self._collection.createIndexAsync)
      throw new Error('Can only call createIndexAsync on server collections');
    if (self._collection.createIndexAsync) {
      await self._collection.createIndexAsync(index, options);
    } else {
      import { Log } from 'meteor/logging';

      Log.debug(`ensureIndexAsync has been deprecated, please use the new 'createIndexAsync' instead${ options?.name ? `, index name: ${ options.name }` : `, index: ${ JSON.stringify(index) }` }`)
      await self._collection.ensureIndexAsync(index, options);
    }
  },

  /**
   * @summary Asynchronously creates the specified index on the collection.
   * @locus server
   * @method createIndexAsync
   * @memberof Mongo.Collection
   * @instance
   * @param {Object} index A document that contains the field and value pairs where the field is the index key and the value describes the type of index for that field. For an ascending index on a field, specify a value of `1`; for descending index, specify a value of `-1`. Use `text` for text indexes.
   * @param {Object} [options] All options are listed in [MongoDB documentation](https://docs.mongodb.com/manual/reference/method/db.collection.createIndex/#options)
   * @param {String} options.name Name of the index
   * @param {Boolean} options.unique Define that the index values must be unique, more at [MongoDB documentation](https://docs.mongodb.com/manual/core/index-unique/)
   * @param {Boolean} options.sparse Define that the index is sparse, more at [MongoDB documentation](https://docs.mongodb.com/manual/core/index-sparse/)
   */
  async createIndexAsync(index, options) {
    var self = this;
    if (!self._collection.createIndexAsync)
      throw new Error('Can only call createIndexAsync on server collections');

    try {
      await self._collection.createIndexAsync(index, options);
    } catch (e) {
      if (
        e.message.includes(
          'An equivalent index already exists with the same name but different options.'
        ) &&
        Meteor.settings?.packages?.mongo?.reCreateIndexOnOptionMismatch
      ) {
        import { Log } from 'meteor/logging';

        Log.info(`Re-creating index ${ index } for ${ self._name } due to options mismatch.`);
        await self._collection.dropIndexAsync(index);
        await self._collection.createIndexAsync(index, options);
      } else {
        console.error(e);
        throw new Meteor.Error(`An error occurred when creating an index for collection "${ self._name }: ${ e.message }`);
      }
    }
  },

  /**
   * @summary Asynchronously creates the specified index on the collection.
   * @locus server
   * @method createIndex
   * @memberof Mongo.Collection
   * @instance
   * @param {Object} index A document that contains the field and value pairs where the field is the index key and the value describes the type of index for that field. For an ascending index on a field, specify a value of `1`; for descending index, specify a value of `-1`. Use `text` for text indexes.
   * @param {Object} [options] All options are listed in [MongoDB documentation](https://docs.mongodb.com/manual/reference/method/db.collection.createIndex/#options)
   * @param {String} options.name Name of the index
   * @param {Boolean} options.unique Define that the index values must be unique, more at [MongoDB documentation](https://docs.mongodb.com/manual/core/index-unique/)
   * @param {Boolean} options.sparse Define that the index is sparse, more at [MongoDB documentation](https://docs.mongodb.com/manual/core/index-sparse/)
   */
  createIndex(index, options){
    return this.createIndexAsync(index, options);
  },

  async dropIndexAsync(index) {
    var self = this;
    if (!self._collection.dropIndexAsync)
      throw new Error('Can only call dropIndexAsync on server collections');
    await self._collection.dropIndexAsync(index);
  },

  async dropCollectionAsync() {
    var self = this;
    if (!self._collection.dropCollectionAsync)
      throw new Error('Can only call dropCollectionAsync on server collections');
   await self._collection.dropCollectionAsync();
  },

  async createCappedCollectionAsync(byteSize, maxDocuments) {
    var self = this;
    if (! await self._collection.createCappedCollectionAsync)
      throw new Error(
        'Can only call createCappedCollectionAsync on server collections'
      );
    await self._collection.createCappedCollectionAsync(byteSize, maxDocuments);
  },

  /**
   * @summary Returns the [`Collection`](http://mongodb.github.io/node-mongodb-native/3.0/api/Collection.html) object corresponding to this collection from the [npm `mongodb` driver module](https://www.npmjs.com/package/mongodb) which is wrapped by `Mongo.Collection`.
   * @locus Server
   * @memberof Mongo.Collection
   * @instance
   */
  rawCollection() {
    var self = this;
    if (!self._collection.rawCollection) {
      throw new Error('Can only call rawCollection on server collections');
    }
    return self._collection.rawCollection();
  },

  /**
   * @summary Returns the [`Db`](http://mongodb.github.io/node-mongodb-native/3.0/api/Db.html) object corresponding to this collection's database connection from the [npm `mongodb` driver module](https://www.npmjs.com/package/mongodb) which is wrapped by `Mongo.Collection`.
   * @locus Server
   * @memberof Mongo.Collection
   * @instance
   */
  rawDatabase() {
    var self = this;
    if (!(self._driver.mongo && self._driver.mongo.db)) {
      throw new Error('Can only call rawDatabase on server collections');
    }
    return self._driver.mongo.db;
  },
});

Object.assign(Mongo, {
  /**
   * @summary Retrieve a Meteor collection instance by name. Only collections defined with [`new Mongo.Collection(...)`](#collections) are available with this method. For plain MongoDB collections, you'll want to look at [`rawDatabase()`](#Mongo-Collection-rawDatabase).
   * @locus Anywhere
   * @memberof Mongo
   * @static
   * @param {string} name Name of your collection as it was defined with `new Mongo.Collection()`.
   * @returns {Mongo.Collection | undefined}
   */
  getCollection(name) {
    return this._collections.get(name);
  },

  /**
   * @summary A record of all defined Mongo.Collection instances, indexed by collection name.
   * @type {Map<string, Mongo.Collection>}
   * @memberof Mongo
   * @protected
   */
  _collections: new Map(),
})



/**
 * @summary Create a Mongo-style `ObjectID`.  If you don't specify a `hexString`, the `ObjectID` will be generated randomly (not using MongoDB's ID construction rules).
 * @locus Anywhere
 * @class
 * @param {String} [hexString] Optional.  The 24-character hexadecimal contents of the ObjectID to create
 */
Mongo.ObjectID = MongoID.ObjectID;

/**
 * @summary To create a cursor, use find. To access the documents in a cursor, use forEach, map, or fetch.
 * @class
 * @instanceName cursor
 */
Mongo.Cursor = LocalCollection.Cursor;

/**
 * @deprecated in 0.9.1
 */
Mongo.Collection.Cursor = Mongo.Cursor;

/**
 * @deprecated in 0.9.1
 */
Mongo.Collection.ObjectID = Mongo.ObjectID;

/**
 * @deprecated in 0.9.1
 */
Meteor.Collection = Mongo.Collection;

// Allow deny stuff is now in the allow-deny package
Object.assign(Mongo.Collection.prototype, AllowDeny.CollectionPrototype);

