exports.attach = function(options) {
  var app = this;
  var _ = require('underscore');
  var $ = require('cheerio');
  var async = require('async');
  var check = require('validator').check;
  var feedparser = require('feedparser');
  var mongoose = require('mongoose');
  var uri = require('url');

  var userSchema = mongoose.Schema({
    mail: {type: String, index: {unique: true}},
    pass: String,
    created: Date,
    subscriptions: mongoose.Schema.Types.Mixed,
    high: Date,
    low: Date,
    narrow: Boolean,
    verification: {type: String, index: true},
    verified: {type: Boolean, index: true},
  }, {
    minimize: false,
  });

  /**
   * Subscribe user to a given channel.
   */
  userSchema.methods.subscribe = function(url, callback) {
    var self = this;
    var channel = null;
    var feed = null;

    async.series([
      // Parse the feed contents.
      function(next) {
        app.parseFeed(url, function(err, parsed_feed) {
          if (err) {
            next(err);
          }
          else {
            feed = parsed_feed;
            next();
          }
        });
      },
      // Check that the channel exists and create it if necessary.
      function(next) {
        app.channel.findOne({url: feed.url}, function(err, doc) {
          if (doc) {
            channel = doc;
            next();
          }
          else {
            channel = new app.channel({type: feed.type, url: feed.url, domain: feed.domain});
            channel.save(function(err) {
              next(err);
            });
          }
        });
      },
      // Update the channel items.
      function(next) {
        channel.crawl(function() {
          next();
        });
      },
      // Create a list (subscription) for the user.
      function(next) {
        app.list.createFromChannel(self._id, channel._id, feed.title, function(err) {
          err ? next("Could not update user subscription.") : next();
        });
      },
      // Increment channel's subscribers counter.
      function(next) {
        channel.updateSubscriberCount(function(err) {
          err ? next("Could not increment subscribers.") : next();
        });
      },
    ], function(err) {
      app.notify.onSubscribe(self, channel);
      callback(err, channel);
    });
  }

  /**
   * Subscribe user to a given channel.
   */
  userSchema.methods.subscribeToChannel = function(channel_id, callback) {
    var self = this;
    var channel = false;

    async.series([
      // Load channel.
      function(next) {
        app.channel.findById(channel_id, function(err, ch) {
          channel = ch;
          next(err);
        });
      },
      // Check that the user is not yet subscribed.
      function(next) {
        app.list.count({user_id: self._id, channel_id: channel_id}, function(err, count) {
          if (count) {
            next("You are already subscribed to this site.");
          }
          else {
            next();
          }
        });
      },
      // Create a list for this subscription.
      function(next) {
        app.list.create({type: "channel", name: channel.title, user_id: self._id, channel_id: channel_id, weight: null}, function(err) {
          err ? next("Could not subscribe to this site.") : next();
        });
      },
      // Increment channel's subscribers counter.
      function(next) {
        channel.updateSubscriberCount(function(err) {
          err ? next("Could not increment subscribers.") : next();
        });
      }
    ], function(err) {
      app.notify.onSubscribe(self, channel);
      callback(err, channel);
    });
  }

  /**
   * Unsubscribe user from a given channel.
   */
  userSchema.methods.unsubscribe = function(channel_id, callback) {
    var self = this;

    app.list.remove({user_id: self._id, channel_id: channel_id}, function(err) {
      app.channel.findById(channel_id, function(err, channel) {
        channel.updateSubscriberCount(function(err) {
          app.notify.onUnSubscribe(self, channel);
          callback();
        });
      });
    });
  }

  /**
   * Load all the channels the given user has subscribed to.
   */
  userSchema.methods.subscribedChannels = function(callback) {
    var subscriptions = [];

    for (var channel_id in this.subscriptions) {
      subscriptions.push(app.objectId(channel_id));
    }

    app.channel.find({_id: {$in: subscriptions}}, function(err, channels) {
      if (err) {
        throw err;
      }
      else {
        callback(channels);
      }
    });
  }

  /**
   * Load all channels that have been updated since the user last requested them.
   */
  userSchema.methods.getChannelUpdates = function(state, callback) {
    var self = this;
    var ids = [];
    var updates = [];

    if (state) {
      for (var id in state) {
        ids.push(app.objectId(id));
      }

      app.channel.find({_id: {$in: ids}}, function(err, results) {
        if (err) throw err;

        for (var i in results) {
          var time = results[i].items_added ? results[i].items_added.getTime() : 0;

          if ((time > new Date(state[results[i]._id]))) {
            for (var j = 0; j < results[i].items.length; j++) {
              results[i].items[j].created = results[i].items[j].created.getTime();
            }

            updates.push({_id: results[i]._id, items_added: results[i].items_added.getTime(), items: results[i].items});
          }
        }

        callback(updates);
      });
    }
    else {
      callback([]);
    }
  }

  /**
   * Activate the user account and set the username, password.
   */
  userSchema.methods.activate = function(callback) {
    var self = this;

    this.verified = true;

    this.save(function(err) {
      app.notify.onActivate(self);
      callback(err);
    });
  }

  /**
   * Try to authenticate the user, create an account on the fly if not present.
   */
  userSchema.statics.findOrCreate = function(mail, callback) {
    var date = new Date();

    app.user.findOne({mail: mail}, function(err, user) {
      if (user) {
        callback(null, user);
      }
      else {
        app.user.create({mail: mail, pass: null, subscriptions: {}, created: date, high: date, low: date, verification: null, verified: true}, function(err, user) {
          app.mail({to: user.mail, subject: 'Welcome to pagetty.com'}, 'signup_auto', {user: user});
          callback(err, user);
        });
      }
    });
  }

  /**
   * TODO
   */
  userSchema.statics.signup = function(data, callback) {
    var validator = app.getValidator();

    validator.check(data.mail, 'E-mail is not valid.').isEmail();
    validator.check(data.pass, 'Password is required.').notEmpty();
    validator.check(data.pass, 'Password must contain at least 6 characters.').len(6);
    validator.check(data.pass, 'Passwords do not match.').equals(data.pass2);

    if (validator.hasErrors()) {
      callback(validator.getErrors()[0]);
      return;
    }

    async.series([
      function(next) {
        app.user.findOne({mail: data.mail}, function(err, user) {
          user == null ? next(null) : next('E-mail is already in use.');
        });
      },
    ], function(err) {
      if (err) {
        callback(err);
      }
      else {
        var id = new mongoose.Types.ObjectId(id);
        var pass = app.user.hashPassword(id.toString(), data.pass);
        var date = new Date();
        var verification = require('crypto').createHash('sha1').update('qwmi39ds' + date.getTime(), 'utf8').digest('hex');
        var user = new app.user({_id: id, mail: data.mail, pass: pass, subscriptions: {}, created: date, high: date, low: date, verification: verification, verified: false});

        user.save(function(err) {
          if (err) {
            callback("Unable to create user account.");
          }
          else {
            app.list.createUserDefaults(user, function(err) {
              app.mail({to: user.mail, subject: 'Welcome to pagetty.com'}, 'signup', {user: user});
              app.notify.onSignup(user);
              callback(null, user);
            });
          }
        });
      }
    });
  }

  /**
   * Check the user's login credentials.
   */
  userSchema.statics.authenticate = function(mail, plainPass, callback) {
    var self = this;

    this.findOne({mail: mail, verified: true}, function(err, user) {
      if (user == null || !(user.pass == self.hashPassword(user._id, plainPass))) {
        callback("Username or password does not match.");
      }
      else {
        callback(null, user);
      }
    });
  }

  /**
   * Create a secure hash from user_id + plain password pair.
   */
  userSchema.statics.hashPassword = function(id, plainPass) {
    return require('crypto').createHash('sha1').update('lwearGYw3p29' + id + plainPass, 'utf8').digest('hex');
  }

  /**
   * Check if the given username is unique.
   */
  userSchema.statics.checkIfUsernameUnique = function(username, callback) {
    this.findOne({name: username}, function(err, doc) {
      callback(err == null && doc != null);
    });
  }

  /**
   * Verify the user's account.
   */
  userSchema.statics.checkIfUnverified = function(user_id, callback) {
    this.findOne({_id: id, verified: false}, function(err, doc) {
      if (err || (doc == null)) {
        if (err) throw err;
        callback('User not found or already verified.')
      }
      else {
        callback();
      }
    });
  }

  /**
   * Delete user's account and all associated data.
   */
  userSchema.post('remove', function() {
    var self = this;

    async.series([
      function(next) {
        app.state.remove({user: self._id}, function(err) {
          next(err);
        })
      },
      function(next) {
        self.subscribedChannels(function(channels) {
          for (var i in channels) {
            channels[i].updateSubscriberCount(function() {});
          }

          next();
        });
      },
      function(next) {
        app.notify.onAccountDelete(self);
        next();
      }
    ]);
  });

  this.user = this.db.model('User', userSchema, 'users');
}