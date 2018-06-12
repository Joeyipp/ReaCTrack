const mongoose = require('mongoose');

var phq9 = mongoose.model('PHQ9', {
  userId: {
    type: String,
    required: true,
    trim: true,
    minlength: 1,
    unique: true
  },
  phq9_1: {
    score: [{
      type: Number,
      default: null
    }],
    dateTime: [{
      type: String,
      default: null
    }]
  },
  phq9_2: {
    score: [{
      type: Number,
      default: null
    }],
    dateTime: [{
      type: String,
      default: null
    }]
  },
  phq9_3: {
    score: [{
      type: Number,
      default: null
    }],
    dateTime: [{
      type: String,
      default: null
    }]
  },
  phq9_4: {
    score: [{
      type: Number,
      default: null
    }],
    dateTime: [{
      type: String,
      default: null
    }]
  },
  phq9_5: {
    score: [{
      type: Number,
      default: null
    }],
    dateTime: [{
      type: String,
      default: null
    }]
  },
  phq9_6: {
    score: [{
      type: Number,
      default: null
    }],
    dateTime: [{
      type: String,
      default: null
    }]
  },
  phq9_7: {
    score: [{
      type: Number,
      default: null
    }],
    dateTime: [{
      type: String,
      default: null
    }]
  },
  phq9_8: {
    score: [{
      type: Number,
      default: null
    }],
    dateTime: [{
      type: String,
      default: null
    }]
  },
  phq9_9: {
    score: [{
      type: Number,
      default: null
    }],
    dateTime: [{
      type: String,
      default: null
    }]
  },
  phq9_total: {
    score: [{
      type: Number,
      default: null
    }],
    dateTime: [{
      type: String,
      default: null
    }]
  }
});

module.exports = {phq9};
