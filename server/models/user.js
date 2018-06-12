const request = require('request');
const config = require('./../config/config');
const moment = require('moment');
var {mongoose} = require('./../db/mongoose');

var User = mongoose.model('User', {
  userId: {
    type: String,
    required: true,
    trim: true,
    minlength: 1,
    unique: true
  },
  firstName: {
    type: String,
    required: true
  },
  lastName: {
    type: String,
    required: true
  },
  locale: {
    type: String
  },
  timeZone: {
    type: String
  },
  gender: {
    type: String
  },
  medication: {
    name: {
      type: String
    },
    schedule: {
      type: Number
    },
    reminder: {
      type: String
    }
  },
  startTime: {
    type: String,
    required: true
  },
  duration: {
    type: Number,
    default: null
  }
});

var userData = (callback, userId) => {
	request({
		uri: 'https://graph.facebook.com/v2.7/' + userId,
		qs: {
			access_token: config.FB_PAGE_TOKEN
		}
	}, (error, response, body) => {
		if (!error && response.statusCode == 200) {
			var user = JSON.parse(body);
      var startTime = moment().format('lll');

      if (user.first_name) {
				console.log("FB user: %s %s, %s", user.first_name, user.last_name, user.gender);
        let userId = user.id;

        // Insert info into database
        var userDetails = new User({
          userId,
          firstName: user.first_name,
          lastName: user.last_name,
          locale: user.locale,
          timeZone: user.timezone,
          gender: user.gender,
          startTime
        });

        User.find({userId}).then((doc) => {
          if (doc[0]) {
            console.log("User exists!");
          }
          else {
            userDetails.save().then((doc) => {
              console.log("User details saved!");
            }, (e) => {
              console.log(e);
            });
          }
        }, (e) => {
          console.log(e);
        }).catch((e) => {
          console.log(e);
        });

        callback(user);
      } else {
  				console.log("Cannot get data for fb user with id", userId);
        }
      } else {
        console.error(response.error);
      }
    });
};

module.exports = {User, userData};
