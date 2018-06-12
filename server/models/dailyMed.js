const mongoose = require('mongoose');

var dailyMed = mongoose.model('DailyMed', {
  userId: {
    type: String,
    required: true,
    trim: true,
    minlength: 1,
    unique: true,
  },
  medication: {
    dateTime: [{
      type: String,
      required: true
    }],
    taken: [{
      type: Boolean,
      default: false
    }],
    not_taken_reason: [{
      type: String,
      default: null
    }],
    effectiveness: [{
      type: Number,
      default: null
    }]
  }
});

module.exports = {dailyMed};
