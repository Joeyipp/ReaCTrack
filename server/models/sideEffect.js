const mongoose = require('mongoose');

var sideEffect = mongoose.model('SideEffect', {
  userId: {
    type: String,
    required: true,
    trim: true,
    minlength: 1,
    unique: true,
  },
  dateTime: [{
    type: String,
    required: true
  }],
  symptom: [{
    type: String,
    required: true
  }]
});

module.exports = {sideEffect};
