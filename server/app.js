'use strict';

const apiai = require('apiai');
const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const moment = require('moment');
const bodyParser = require('body-parser');
const request = require('request');
const uuid = require('uuid');
const config = require('./config/config');
const mysql = require('mysql');
const nodeadmin = require('nodeadmin');

// Local Imports
var {mongoose} = require('./db/mongoose');
var {User, userData} = require('./models/user');
var {phq9} = require('./models/phq9');
var {dailyMed} = require('./models/dailyMed');
var {sideEffect} = require('./models/sideEffect');

// Messenger API parameters
if (!config.FB_PAGE_TOKEN) {
	throw new Error('missing FB_PAGE_TOKEN');
}
if (!config.FB_VERIFY_TOKEN) {
	throw new Error('missing FB_VERIFY_TOKEN');
}
if (!config.API_AI_CLIENT_ACCESS_TOKEN) {
	throw new Error('missing API_AI_CLIENT_ACCESS_TOKEN');
}
if (!config.FB_APP_SECRET) {
	throw new Error('missing FB_APP_SECRET');
}
if (!config.SERVER_URL) { //used for ink to static files
	throw new Error('missing SERVER_URL');
}

// MySQL DB
const db = mysql.createConnection({
	host: config.MYSQL_HOST,
	user: config.MYSQL_USER,
	password: config.MYSQL_PASS,
	database: config.MYSQL_DB
});

// Connect to MySQL DB
db.connect((err) => {
	if (err) {
		throw err;
	}
	console.log("MySQL DB connected ...");
});

// Setup Express-app
var app = express();
app.set('port', (process.env.PORT || 5000))

// Use Node Admin
app.use(nodeadmin(app));

//verify request came from facebook
app.use(bodyParser.json({
	verify: verifyRequestSignature
}));

//serve static files in the public directory
app.use(express.static(__dirname + '/public'));

// Process application/x-www-form-urlencoded
app.use(bodyParser.urlencoded({
	extended: false
}))

// Process application/json
app.use(bodyParser.json())

const apiAiService = apiai(config.API_AI_CLIENT_ACCESS_TOKEN, {
	language: "en",
	requestSource: "fb"
});
const sessionIds = new Map();
const usersMap = new Map();

// Index route
app.get('/', function (req, res) {
	res.send('Hello, my name is ReaCTrack, your personal bot!')
})

// for Facebook verification
app.get('/webhook/', function (req, res) {
	console.log("request");
	if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === config.FB_VERIFY_TOKEN) {
		res.status(200).send(req.query['hub.challenge']);
	} else {
		console.error("Failed validation. Make sure the validation tokens match.");
		res.sendStatus(403);
	}
})

/*
 * All callbacks for Messenger are POST-ed. They will be sent to the same
 * webhook. Be sure to subscribe your app to your page to receive callbacks
 * for your page.
 * https://developers.facebook.com/docs/messenger-platform/product-overview/setup#subscribe_app
 *
 */
app.post('/webhook/', function (req, res) {
	var data = req.body;
	console.log(JSON.stringify(data));

	// Make sure this is a page subscription
	if (data.object == 'page') {
		// Iterate over each entry
		// There may be multiple if batched
		data.entry.forEach(function (pageEntry) {
			var pageID = pageEntry.id;
			var timeOfEvent = pageEntry.time;

			// Iterate over each messaging event
			pageEntry.messaging.forEach(function (messagingEvent) {
				if (messagingEvent.optin) {
					receivedAuthentication(messagingEvent);
				} else if (messagingEvent.message) {
					receivedMessage(messagingEvent);
				} else if (messagingEvent.delivery) {
					receivedDeliveryConfirmation(messagingEvent);
				} else if (messagingEvent.postback) {
					receivedPostback(messagingEvent);
				} else if (messagingEvent.read) {
					receivedMessageRead(messagingEvent);
				} else if (messagingEvent.account_linking) {
					receivedAccountLink(messagingEvent);
				} else {
					console.log("Webhook received unknown messagingEvent: ", messagingEvent);
				}
			});
		});

		// Assume all went well.
		// You must send back a 200, within 20 seconds
		res.sendStatus(200);
	}
});

function setSessionAndUser(senderID) {
	if (!sessionIds.has(senderID)) {
		sessionIds.set(senderID, uuid.v1());
	}

	if (!usersMap.has(senderID)) {
		userData((user) => {
			usersMap.set(senderID, user);
		}, senderID);
	}
}

function receivedMessage(event) {
	var senderID = event.sender.id; 			// User that sends us the message
	var recipientID = event.recipient.id;
	var timeOfMessage = event.timestamp;	// Time of message
	var serverTime = moment().format('lll');
	var message = event.message;					// The actual message

	setSessionAndUser(senderID);
	// console.log("Received message for user %d and page %d at %d with message:", senderID, recipientID, timeOfMessage);
	// console.log(JSON.stringify(message));

	var isEcho = message.is_echo;
	var messageId = message.mid;
	var appId = message.app_id;
	var metadata = message.metadata;

	// You may get a text or attachment but not both
	var messageText = message.text;
	var messageAttachments = message.attachments;
	var quickReply = message.quick_reply;

	// Log to log.txt
	var logData = `${serverTime} ${senderID}: ${messageText}\n`;
	fs.appendFileSync('log.txt', logData);

	if (isEcho) {
		handleEcho(messageId, appId, metadata);
		return;
	} else if (quickReply) {
		handleQuickReply(senderID, quickReply, messageId);
		return;
	}

	if (messageText) {
		//send message to api.ai
		sendToApiAi(senderID, messageText);
	} else if (messageAttachments) {
		handleMessageAttachments(messageAttachments, senderID);
	}
}

function handleMessageAttachments(messageAttachments, senderID){
	//for now just reply
	sendTextMessage(senderID, "Attachment received. Thank you.");
}

function handleQuickReply(senderID, quickReply, messageId) {
	var quickReplyPayload = quickReply.payload;
	console.log("Quick reply for message %s with payload %s", messageId, quickReplyPayload);
	//send payload to api.ai
	sendToApiAi(senderID, quickReplyPayload);
}

//https://developers.facebook.com/docs/messenger-platform/webhook-reference/message-echo
function handleEcho(messageId, appId, metadata) {
	// Just logging message echoes to console
	console.log("Received echo for message %s and app %d with metadata %s", messageId, appId, metadata);
}

function handleApiAiAction(sender, action, responseText, contexts, parameters, resolvedQuery) {
	var dateTime = moment().format('lll');
	var score;

	if (parameters["phq-9-res"] === "Not at all") {
		score = 0;
	}
	else if (parameters["phq-9-res"] === "Several days") {
		score = 1;
	}
	else if (parameters["phq-9-res"] === "Nearly every day") {
		score = 3;
	}
	else {
		score = 2;
	}

	var med_name = parameters["medication"];

	switch (action) {
		case "phq9_1":
			phq9.findOne({userId: sender}).then((doc) => {
				if (doc) {
					var scoreArray = doc["phq9_1"]["score"];
					var dateTimeArray = doc["phq9_1"]["dateTime"];

					scoreArray.push(score);
					dateTimeArray.push(dateTime);

					phq9.findOneAndUpdate({
						userId: sender
					}, {
						$set: {
							"phq9_1.score": scoreArray,
							"phq9_1.dateTime": dateTimeArray
						}
					}).then((doc) => {
							console.log("phq9_1 response pushed!");
						})
				}
				else {
					var phq9_1 = new phq9({
						userId: sender,
						phq9_1: {
							score,
							dateTime
						}
					});

					phq9_1.save().then((doc) => {
						console.log("phq9_1 response saved!");
					}, (e) => {
						console.log(e);
					});
				}
			}, (e) => {
				console.log(e);
			}).catch((e) => {
				console.log(e);
			});
			break;

		case "phq9_2":
			phq9.findOne({userId: sender}).then((doc) => {
					var scoreArray = doc["phq9_2"]["score"];
					var dateTimeArray = doc["phq9_2"]["dateTime"];

					scoreArray.push(score);
					dateTimeArray.push(dateTime);

					phq9.findOneAndUpdate({
						userId: sender
					}, {
						$set: {
							"phq9_2.score": scoreArray,
							"phq9_2.dateTime": dateTimeArray
						}
					}).then((doc) => {
							console.log("phq9_2 response pushed!");
					})
			}, (e) => {
				console.log(e);
			}).catch((e) => {
				console.log(e);
			});
			break;

		case "phq9_3":
			phq9.findOne({userId: sender}).then((doc) => {
					var scoreArray = doc["phq9_3"]["score"];
					var dateTimeArray = doc["phq9_3"]["dateTime"];

					scoreArray.push(score);
					dateTimeArray.push(dateTime);

					phq9.findOneAndUpdate({
						userId: sender
					}, {
						$set: {
							"phq9_3.score": scoreArray,
							"phq9_3.dateTime": dateTimeArray
						}
					}).then((doc) => {
							console.log("phq9_3 response pushed!");
					})
			}, (e) => {
				console.log(e);
			}).catch((e) => {
				console.log(e);
			});
			break;

		case "phq9_4":
			phq9.findOne({userId: sender}).then((doc) => {
					var scoreArray = doc["phq9_4"]["score"];
					var dateTimeArray = doc["phq9_4"]["dateTime"];

					scoreArray.push(score);
					dateTimeArray.push(dateTime);

					phq9.findOneAndUpdate({
						userId: sender
					}, {
						$set: {
							"phq9_4.score": scoreArray,
							"phq9_4.dateTime": dateTimeArray
						}
					}).then((doc) => {
							console.log("phq9_4 response pushed!");
					})
			}, (e) => {
				console.log(e);
			}).catch((e) => {
				console.log(e);
			});
			break;

		case "phq9_5":
			phq9.findOne({userId: sender}).then((doc) => {
					var scoreArray = doc["phq9_5"]["score"];
					var dateTimeArray = doc["phq9_5"]["dateTime"];

					scoreArray.push(score);
					dateTimeArray.push(dateTime);

					phq9.findOneAndUpdate({
						userId: sender
					}, {
						$set: {
							"phq9_5.score": scoreArray,
							"phq9_5.dateTime": dateTimeArray
						}
					}).then((doc) => {
							console.log("phq9_5 response pushed!");
					})
			}, (e) => {
				console.log(e);
			}).catch((e) => {
				console.log(e);
			});
			break;

		case "phq9_6":
			phq9.findOne({userId: sender}).then((doc) => {
					var scoreArray = doc["phq9_6"]["score"];
					var dateTimeArray = doc["phq9_6"]["dateTime"];

					scoreArray.push(score);
					dateTimeArray.push(dateTime);

					phq9.findOneAndUpdate({
						userId: sender
					}, {
						$set: {
							"phq9_6.score": scoreArray,
							"phq9_6.dateTime": dateTimeArray
						}
					}).then((doc) => {
							console.log("phq9_6 response pushed!");
					})
			}, (e) => {
				console.log(e);
			}).catch((e) => {
				console.log(e);
			});
			break;

		case "phq9_7":
			phq9.findOne({userId: sender}).then((doc) => {
					var scoreArray = doc["phq9_7"]["score"];
					var dateTimeArray = doc["phq9_7"]["dateTime"];

					scoreArray.push(score);
					dateTimeArray.push(dateTime);

					phq9.findOneAndUpdate({
						userId: sender
					}, {
						$set: {
							"phq9_7.score": scoreArray,
							"phq9_7.dateTime": dateTimeArray
						}
					}).then((doc) => {
							console.log("phq9_7 response pushed!");
					})
			}, (e) => {
				console.log(e);
			}).catch((e) => {
				console.log(e);
			});
			break;

		case "phq9_8":
			phq9.findOne({userId: sender}).then((doc) => {
					var scoreArray = doc["phq9_8"]["score"];
					var dateTimeArray = doc["phq9_8"]["dateTime"];

					scoreArray.push(score);
					dateTimeArray.push(dateTime);

					phq9.findOneAndUpdate({
						userId: sender
					}, {
						$set: {
							"phq9_8.score": scoreArray,
							"phq9_8.dateTime": dateTimeArray
						}
					}).then((doc) => {
							console.log("phq9_8 response pushed!");
					})
			}, (e) => {
				console.log(e);
			}).catch((e) => {
				console.log(e);
			});
			break;

		case "phq9_9":
			phq9.findOne({userId: sender}).then((doc) => {
					var scoreArray = doc["phq9_9"]["score"];
					var dateTimeArray = doc["phq9_9"]["dateTime"];

					scoreArray.push(score);
					dateTimeArray.push(dateTime);

					phq9.findOneAndUpdate({
						userId: sender
					}, {
						$set: {
							"phq9_9.score": scoreArray,
							"phq9_9.dateTime": dateTimeArray
						}
					}).then((doc) => {
							console.log("phq9_9 response pushed!");
					});

					var phq9_totalArray = doc["phq9_total"]["score"];
					var phq9_dateTimeArray = doc["phq9_total"]["dateTime"];

					var phq9_1 = doc["phq9_1"]["score"];
					var phq9_1_score = phq9_1[phq9_1.length - 1];

					var phq9_2 = doc["phq9_2"]["score"];
					var phq9_2_score = phq9_2[phq9_2.length - 1];

					var phq9_3 = doc["phq9_3"]["score"];
					var phq9_3_score = phq9_3[phq9_3.length - 1];

					var phq9_4 = doc["phq9_4"]["score"];
					var phq9_4_score = phq9_4[phq9_4.length - 1];

					var phq9_5 = doc["phq9_5"]["score"];
					var phq9_5_score = phq9_5[phq9_5.length - 1];

					var phq9_6 = doc["phq9_6"]["score"];
					var phq9_6_score = phq9_6[phq9_6.length - 1];

					var phq9_7 = doc["phq9_7"]["score"];
					var phq9_7_score = phq9_7[phq9_7.length - 1];

					var phq9_8 = doc["phq9_8"]["score"];
					var phq9_8_score = phq9_8[phq9_8.length - 1];

					var phq9_9 = doc["phq9_9"]["score"];
					var phq9_9_score = phq9_9[phq9_9.length - 1];

					var phq9_total = phq9_1_score + phq9_2_score + phq9_3_score + phq9_4_score + phq9_5_score + phq9_6_score + phq9_7_score + phq9_8_score + phq9_9_score;

					phq9_totalArray.push(phq9_total);
					phq9_dateTimeArray.push(dateTime);

					phq9.findOneAndUpdate({
						userId: sender
					}, {
						$set: {
							"phq9_total.score": phq9_totalArray,
							"phq9_total.dateTime": phq9_dateTimeArray
						}
					}).then((doc) => {
							console.log("phq9_total calculated!");
					})
				}, (e) => {
					console.log(e);
				}).catch((e) => {
					console.log(e);
				});
			break;

			case "prescribed_med":
				if (parameters["medication"] && parameters["number"]) {
					var prescribed_med = parameters["medication"];
					var med_schedule = parameters["number"];

					User.findOneAndUpdate({
						userId: sender
					}, {
						$set: {
							"medication.name": prescribed_med,
							"medication.schedule": med_schedule
						}
					}).then((doc) => {
						console.log("Prescribed medication & schedule updated!");
					}).catch((e) => {
						console.log(e);
					});
				}

				break;

		case "med_reminder":
			var med_reminder = parameters["time"];

			User.findOneAndUpdate({
				userId: sender
			}, {
				$set: {
					"medication.reminder": med_reminder
				}
			}).then((doc) => {
				console.log("Medication reminder updated!");
			}).catch((e) => {
				console.log(e);
			});
			break;

		case "med_taken":
			var med_taken = parameters["med_taken"];

			dailyMed.findOne({userId: sender}).then((doc) => {
				if (doc) {
					var med_takenArray = doc["medication"]["taken"];
					var dateTimeArray = doc["medication"]["dateTime"];
					var not_taken_reasonArray = doc["medication"]["not_taken_reason"];

					med_takenArray.push(med_taken);
					dateTimeArray.push(dateTime);
					not_taken_reasonArray.push("NA");

					dailyMed.findOneAndUpdate({
						userId: sender
					}, {
						$set: {
							"medication.taken": med_takenArray,
							"medication.dateTime": dateTimeArray,
							"medication.not_taken_reason": not_taken_reasonArray
						}
					}).then((doc) => {
							console.log("Med_taken response pushed!");
						})
				}
				else {
					var med = new dailyMed({
						userId: sender,
						medication: {
							taken: med_taken,
							dateTime,
							not_taken_reason: "NA"
						}
					});

					med.save().then((doc) => {
						console.log("Med_taken response saved!");
					}, (e) => {
						console.log(e);
					});
				}
			}, (e) => {
				console.log(e);
			}).catch((e) => {
				console.log(e);
			});
			break;

		case "med_not_taken":
			var med_taken = "false";
			var not_taken_reason = resolvedQuery;

			dailyMed.findOne({userId: sender}).then((doc) => {
				if (doc) {
					var med_takenArray = doc["medication"]["taken"];
					var dateTimeArray = doc["medication"]["dateTime"];
					var not_taken_reasonArray = doc["medication"]["not_taken_reason"];
					var effectiveness_Array = doc["medication"]["effectiveness"];

					med_takenArray.push(med_taken);
					dateTimeArray.push(dateTime);
					not_taken_reasonArray.push(not_taken_reason);
					effectiveness_Array.push(-1);

					dailyMed.findOneAndUpdate({
						userId: sender
					}, {
						$set: {
							"medication.taken": med_takenArray,
							"medication.dateTime": dateTimeArray,
							"medication.not_taken_reason": not_taken_reasonArray,
							"medication.effectiveness": effectiveness_Array
						}
					}).then((doc) => {
							console.log("Med_not_taken response pushed!");
						})
				}
				else {
					var med = new dailyMed({
						userId: sender,
						medication: {
							taken: med_taken,
							dateTime,
							not_taken_reason,
							effectiveness: -1
						}
					});

					med.save().then((doc) => {
						console.log("Med_not_taken response saved!");
					}, (e) => {
						console.log(e);
					});
				}
			}, (e) => {
				console.log(e);
			}).catch((e) => {
				console.log(e);
			});
			break;

		case "med_effectiveness":
			var effectiveness = parameters["effectiveness"];

			dailyMed.findOne({userId: sender}).then((doc) => {
					var effectiveness_Array = doc["medication"]["effectiveness"];
					effectiveness_Array.push(effectiveness);

					dailyMed.findOneAndUpdate({
						userId: sender
					}, {
						$set: {
							"medication.effectiveness": effectiveness_Array
						}
					}).then((doc) => {
							console.log("Med_effectiveness response pushed!");
						})
					}).catch((e) => {
						console.log(e);
					});
			break;

		case "check_reminder":

			User.findOne({userId: sender}).then((doc) => {
				var med_reminder = doc["medication"]["reminder"];
				var med_name = doc["medication"]["name"];

				if (med_reminder) {
					let replies = [
						{
							"content_type": "text",
							"title": "Set a new reminder",
							"payload": "Set a new reminder"
						},
						{
							"content_type": "text",
							"title": "Delete a reminder",
							"payload": "Delete a reminder"
						},
						{
							"content_type": "text",
							"title": "Nope, nothing",
							"payload": "Nope, nothing"
						}
					];

					setTimeout(() => {
						sendTextMessage(sender, "You have the following reminder:");
					}, 100);

					setTimeout(() => {
						sendTextMessage(sender, `${med_name} - ${med_reminder}`);
					}, 300);

					setTimeout(() => {
						sendQuickReply(sender, "What would you like to do on your reminder?", replies);
					}, 700);

				}
				else {
					let replies = [
						{
							"content_type": "text",
							"title": "Set a new reminder",
							"payload": "Set a new reminder"
						},
						{
							"content_type": "text",
							"title": "Nothing, I am good",
							"payload": "Nothing, I am good"
						}
					];

					setTimeout(() => {
						sendTextMessage(sender, "You don't seem to have any reminder.");
					}, 100);

					setTimeout(() => {
						sendQuickReply(sender, "What would you like to do?", replies);
					}, 500);
				}
			}).catch((e) => {
				console.log(e);
			});
			break;

		case "symptom":
			var side_effect = parameters["symptom"];

			sideEffect.findOne({userId: sender}).then((doc) => {
				if (doc) {
					var symptomArray = doc["symptom"];
					var dateTimeArray = doc["dateTime"];

					symptomArray.push(side_effect);
					dateTimeArray.push(dateTime);

					sideEffect.findOneAndUpdate({
						userId: sender
					}, {
						$set: {
							"symptom": symptomArray,
							"dateTime": dateTimeArray
						}
					}).then((doc) => {
							console.log("New symptom response pushed!");
						})
				}
				else {
					var symptom = new sideEffect({
						userId: sender,
						dateTime,
						symptom: side_effect
					});

					symptom.save().then((doc) => {
						console.log("Symptom response saved!");
					}, (e) => {
						console.log(e);
					});
				}
			}, (e) => {
				console.log(e);
			}).catch((e) => {
				console.log(e);
			});
			break;


		case "set_new_reminder":
			var new_med_reminder = parameters["time"];

			User.findOneAndUpdate({
				userId: sender
			}, {
				$set: {
					"medication.reminder": new_med_reminder
				}
			}).then((doc) => {
				console.log("Medication reminder updated!");
			}).catch((e) => {
				console.log(e);
			});
			break;

		case "delete_reminder":
			User.findOneAndUpdate({
				userId: sender
			}, {
				$set: {
					"medication.reminder": ""
				}
			}).then((doc) => {
				console.log("Medication reminder updated!");
			}).catch((e) => {
				console.log(e);
			});
			break;

		case "user_sider_usage":
			if (parameters["medication"]) {
				var medication = parameters["medication"];

				sendTextMessage(sender, `The most common usage of ${medication} is`);

				let sql = `SELECT meddra_id from indication WHERE drug_id = (SELECT drug_id from synonym WHERE brand_name = "${medication}") LIMIT 5`;
				let query = db.query(sql, (err, results) => {
					if (err) {
						console.log(err);
					}

					results.forEach((result) => {
						let sql = `SELECT symptom from meddra WHERE meddra_id = "${result.meddra_id}"`;
						let query = db.query(sql, (err, results) => {
							if (err) {
								console.log(err);
							}
							setTimeout(() => {
								sendTextMessage(sender, results[0].symptom);
							}, 300);
						});
					});
				});

				let replies = [
					{
						"content_type": "text",
						"title": "Check my reminder",
						"payload": "Check my reminder"
					},
					{
						"content_type": "text",
						"title": "Share my mood",
						"payload": "Share my mood"
					},
					{
						"content_type": "text",
						"title": "Know another drug",
						"payload": "Know another drug"
					},
					{
						"content_type": "text",
						"title": "Nothing, I am good",
						"payload": "Nothing, I am good"
					}
				];
				setTimeout(() => {
					sendQuickReply(sender, "Anything else you would like to do?", replies);
				}, 1000);
			}
			else {
				sendTextMessage(sender, "Usage of what medication?");
			}
			break;

		case "user_sider_effect":
			if (parameters["medication"]) {
				var medication = parameters["medication"];

				sendTextMessage(sender, `The most common reported side effects of ${medication} include:`);

				let sql = `SELECT meddra_id from sideeffect WHERE drug_id = (SELECT drug_id from synonym WHERE brand_name = "${medication}") ORDER BY frequency DESC LIMIT 5`;
				let query = db.query(sql, (err, results) => {
					if (err) {
						console.log(err);
					}

					results.forEach((result) => {
						let sql = `SELECT symptom from meddra WHERE meddra_id = "${result.meddra_id}"`;
						let query = db.query(sql, (err, results) => {
							if (err) {
								console.log(err);
							}
							setTimeout(() => {
								sendTextMessage(sender, results[0].symptom);
							}, 300);
						});
					});
				});

				let replies = [
					{
						"content_type": "text",
						"title": "Check my reminder",
						"payload": "Check my reminder"
					},
					{
						"content_type": "text",
						"title": "Share my mood",
						"payload": "Share my mood"
					},
					{
						"content_type": "text",
						"title": "Know another drug",
						"payload": "Know another drug"
					},
					{
						"content_type": "text",
						"title": "Nothing, I am good",
						"payload": "Nothing, I am good"
					}
				];
				setTimeout(() => {
					sendQuickReply(sender, "Anything else you would like to do?", replies);
				}, 1000);
			}
			else {
				sendTextMessage(sender, "Side effect of what medication?");
			}
			break;

		default:
			//unhandled action, just send back the text
			sendTextMessage(sender, responseText);
	}
}

function handleMessage(message, sender) {
	let serverTime = moment().format('lll');

	switch (message.type) {
		case 0: //text
			sendTextMessage(sender, message.speech);

			// Log to log.txt
			if (message.speech) {
				var logData = `${serverTime} ReaCTrack: ${message.speech}\n`;
				fs.appendFileSync('log.txt', logData);
			}

			break;
		case 2: //quick replies
			let replies = [];
			for (var b = 0; b < message.replies.length; b++) {
				let reply =
				{
					"content_type": "text",
					"title": message.replies[b],
					"payload": message.replies[b]
				}
				replies.push(reply);
			}
			sendQuickReply(sender, message.title, replies);

			// Log to log.txt
			if (message.title) {
				var logData = `${serverTime} ReaCTrack: ${message.title}\n`;
				fs.appendFileSync('log.txt', logData);
			}

			break;
		case 3: //image
			sendImageMessage(sender, message.imageUrl);
			break;
		case 4:
			// custom payload
			var messageData = {
				recipient: {
					id: sender
				},
				message: message.payload.facebook

			};

			callSendAPI(messageData);

			break;
	}
}

function handleCardMessages(messages, sender) {

	let elements = [];
	for (var m = 0; m < messages.length; m++) {
		let message = messages[m];
		let buttons = [];
		for (var b = 0; b < message.buttons.length; b++) {
			let isLink = (message.buttons[b].postback.substring(0, 4) === 'http');
			let button;
			if (isLink) {
				button = {
					"type": "web_url",
					"title": message.buttons[b].text,
					"url": message.buttons[b].postback
				}
			} else {
				button = {
					"type": "postback",
					"title": message.buttons[b].text,
					"payload": message.buttons[b].postback
				}
			}
			buttons.push(button);
		}


		let element = {
			"title": message.title,
			"image_url":message.imageUrl,
			"subtitle": message.subtitle,
			"buttons": buttons
		};
		elements.push(element);
	}
	sendGenericMessage(sender, elements);
}

function handleApiAiResponse(sender, response) {
	let responseText = response.result.fulfillment.speech;
	let responseData = response.result.fulfillment.data;
	let messages = response.result.fulfillment.messages;
	let action = response.result.action;
	let contexts = response.result.contexts;
	let parameters = response.result.parameters;
	let resolvedQuery = response.result.resolvedQuery;
	let serverTime = moment().format('lll');

	// Log to log.txt
	if (responseText) {
		var logData = `${serverTime} ReaCTrack: ${responseText}\n`;
		fs.appendFileSync('log.txt', logData);
	}

	sendTypingOff(sender);

	if (isDefined(action)) {
		handleApiAiAction(sender, action, responseText, contexts, parameters, resolvedQuery);
	};

	if (isDefined(messages) && (messages.length == 1 && messages[0].type != 0 || messages.length > 1)) {
		let timeoutInterval = 1100;
		let previousType ;
		let cardTypes = [];
		let timeout = 0;
		for (var i = 0; i < messages.length; i++) {

			if ( previousType == 1 && (messages[i].type != 1 || i == messages.length - 1)) {

				timeout = (i - 1) * timeoutInterval;
				setTimeout(handleCardMessages.bind(null, cardTypes, sender), timeout);
				cardTypes = [];
				timeout = i * timeoutInterval;
				setTimeout(handleMessage.bind(null, messages[i], sender), timeout);
			} else if ( messages[i].type == 1 && i == messages.length - 1) {
				cardTypes.push(messages[i]);
                		timeout = (i - 1) * timeoutInterval;
                		setTimeout(handleCardMessages.bind(null, cardTypes, sender), timeout);
                		cardTypes = [];
			} else if ( messages[i].type == 1 ) {
				cardTypes.push(messages[i]);
			} else {
				timeout = i * timeoutInterval;
				setTimeout(handleMessage.bind(null, messages[i], sender), timeout);
			}

			previousType = messages[i].type;

		}
	} else if (responseText == '' && !isDefined(action)) {
		//api ai could not evaluate input.
		console.log('Unknown query' + response.result.resolvedQuery);
		sendTextMessage(sender, "I'm not sure what you want. Can you be more specific?");
	} else if (isDefined(action)) {
		// handleApiAiAction(sender, action, responseText, contexts, parameters, resolvedQuery);
	} else if (isDefined(responseData) && isDefined(responseData.facebook)) {
		try {
			console.log('Response as formatted message' + responseData.facebook);
			sendTextMessage(sender, responseData.facebook);
		} catch (err) {
			sendTextMessage(sender, err.message);
		}
	} else if (isDefined(responseText)) {
		sendTextMessage(sender, responseText);
	}
}

// Make a request to Api.ai
function sendToApiAi(sender, text) {

	// Show typing symbol in Facebook messenger
	sendTypingOn(sender);
	let apiaiRequest = apiAiService.textRequest(text, {
		sessionId: sessionIds.get(sender)
	});

	apiaiRequest.on('response', (response) => {
		if (isDefined(response.result)) {
			handleApiAiResponse(sender, response);
		}
	});

	apiaiRequest.on('error', (error) => console.error(error));
	apiaiRequest.end();
}

function sendTextMessage(recipientId, text) {
	var messageData = {
		recipient: {
			id: recipientId
		},
		message: {
			text: text
		}
	}
	callSendAPI(messageData);
}

/*
 * Send an image using the Send API.
 *
 */
function sendImageMessage(recipientId, imageUrl) {
	var messageData = {
		recipient: {
			id: recipientId
		},
		message: {
			attachment: {
				type: "image",
				payload: {
					url: imageUrl
				}
			}
		}
	};

	callSendAPI(messageData);
}

/*
 * Send a Gif using the Send API.
 *
 */
function sendGifMessage(recipientId) {
	var messageData = {
		recipient: {
			id: recipientId
		},
		message: {
			attachment: {
				type: "image",
				payload: {
					url: config.SERVER_URL + "/assets/instagram_logo.gif"
				}
			}
		}
	};

	callSendAPI(messageData);
}

/*
 * Send audio using the Send API.
 *
 */
function sendAudioMessage(recipientId) {
	var messageData = {
		recipient: {
			id: recipientId
		},
		message: {
			attachment: {
				type: "audio",
				payload: {
					url: config.SERVER_URL + "/assets/sample.mp3"
				}
			}
		}
	};

	callSendAPI(messageData);
}

/*
 * Send a video using the Send API.
 * example videoName: "/assets/allofus480.mov"
 */
function sendVideoMessage(recipientId, videoName) {
	var messageData = {
		recipient: {
			id: recipientId
		},
		message: {
			attachment: {
				type: "video",
				payload: {
					url: config.SERVER_URL + videoName
				}
			}
		}
	};

	callSendAPI(messageData);
}

/*
 * Send a video using the Send API.
 * example fileName: fileName"/assets/test.txt"
 */
function sendFileMessage(recipientId, fileName) {
	var messageData = {
		recipient: {
			id: recipientId
		},
		message: {
			attachment: {
				type: "file",
				payload: {
					url: config.SERVER_URL + fileName
				}
			}
		}
	};

	callSendAPI(messageData);
}

/*
 * Send a button message using the Send API.
 *
 */
function sendButtonMessage(recipientId, text, buttons) {
	var messageData = {
		recipient: {
			id: recipientId
		},
		message: {
			attachment: {
				type: "template",
				payload: {
					template_type: "button",
					text: text,
					buttons: buttons
				}
			}
		}
	};

	callSendAPI(messageData);
}

function sendGenericMessage(recipientId, elements) {
	var messageData = {
		recipient: {
			id: recipientId
		},
		message: {
			attachment: {
				type: "template",
				payload: {
					template_type: "generic",
					elements: elements
				}
			}
		}
	};

	callSendAPI(messageData);
}

function sendReceiptMessage(recipientId, recipient_name, currency, payment_method,
							timestamp, elements, address, summary, adjustments) {
	// Generate a random receipt ID as the API requires a unique ID
	var receiptId = "order" + Math.floor(Math.random() * 1000);

	var messageData = {
		recipient: {
			id: recipientId
		},
		message: {
			attachment: {
				type: "template",
				payload: {
					template_type: "receipt",
					recipient_name: recipient_name,
					order_number: receiptId,
					currency: currency,
					payment_method: payment_method,
					timestamp: timestamp,
					elements: elements,
					address: address,
					summary: summary,
					adjustments: adjustments
				}
			}
		}
	};

	callSendAPI(messageData);
}

/*
 * Send a message with Quick Reply buttons.
 *
 */
function sendQuickReply(recipientId, text, replies, metadata) {
	var messageData = {
		recipient: {
			id: recipientId
		},
		message: {
			text: text,
			metadata: isDefined(metadata)?metadata:'',
			quick_replies: replies
		}
	};

	callSendAPI(messageData);
}

/*
 * Send a read receipt to indicate the message has been read
 *
 */
function sendReadReceipt(recipientId) {
	var messageData = {
		recipient: {
			id: recipientId
		},
		sender_action: "mark_seen"
	};

	callSendAPI(messageData);
}

/*
 * Turn typing indicator on
 *
 */
function sendTypingOn(recipientId) {
	var messageData = {
		recipient: {
			id: recipientId
		},
		sender_action: "typing_on"
	};

	callSendAPI(messageData);
}

/*
 * Turn typing indicator off
 *
 */
function sendTypingOff(recipientId) {
	var messageData = {
		recipient: {
			id: recipientId
		},
		sender_action: "typing_off"
	};

	callSendAPI(messageData);
}

/*
 * Send a message with the account linking call-to-action
 *
 */
function sendAccountLinking(recipientId) {
	var messageData = {
		recipient: {
			id: recipientId
		},
		message: {
			attachment: {
				type: "template",
				payload: {
					template_type: "button",
					text: "Welcome. Link your account.",
					buttons: [{
						type: "account_link",
						url: config.SERVER_URL + "/authorize"
          }]
				}
			}
		}
	};

	callSendAPI(messageData);
}

function greetUserText(userId) {
	let user = usersMap.get(userId);
	sendTextMessage(userId, "Welcome " + user.first_name + '!');
}

/*
 * Call the Send API. The message data goes in the body. If successful, we'll
 * get the message id in a response
 *
 */
function callSendAPI(messageData) {
	request({
		uri: 'https://graph.facebook.com/v2.6/me/messages',
		qs: {
			access_token: config.FB_PAGE_TOKEN
		},
		method: 'POST',
		json: messageData

	}, function (error, response, body) {
		if (!error && response.statusCode == 200) {
			var recipientId = body.recipient_id;
			var messageId = body.message_id;

			if (messageId) {
				console.log("Successfully sent message with id %s to recipient %s",
					messageId, recipientId);
			} else {
				console.log("Successfully called Send API for recipient %s",
					recipientId);
			}
		} else {
			console.error("Failed calling Send API", response.statusCode, response.statusMessage, body.error);
		}
	});
}

/*
 * Postback Event
 *
 * This event is called when a postback is tapped on a Structured Message.
 * https://developers.facebook.com/docs/messenger-platform/webhook-reference/postback-received
 *
 */
function receivedPostback(event) {
	var senderID = event.sender.id;
	var recipientID = event.recipient.id;
	var timeOfPostback = event.timestamp;

	setSessionAndUser(senderID);

	// The 'payload' param is a developer-defined field which is set in a postback
	// button for Structured Messages.
	var payload = event.postback.payload;

	switch (payload) {
		default:
			//unindentified payload
			sendTextMessage(senderID, "I'm not sure what you want. Can you be more specific?");
			break;

	}

	console.log("Received postback for user %d and page %d with payload '%s' " +
		"at %d", senderID, recipientID, payload, timeOfPostback);
}

/*
 * Message Read Event
 *
 * This event is called when a previously-sent message has been read.
 * https://developers.facebook.com/docs/messenger-platform/webhook-reference/message-read
 *
 */
function receivedMessageRead(event) {
	var senderID = event.sender.id;
	var recipientID = event.recipient.id;

	// All messages before watermark (a timestamp) or sequence have been seen.
	var watermark = event.read.watermark;
	var sequenceNumber = event.read.seq;

	console.log("Received message read event for watermark %d and sequence " +
		"number %d", watermark, sequenceNumber);
}

/*
 * Account Link Event
 *
 * This event is called when the Link Account or UnLink Account action has been
 * tapped.
 * https://developers.facebook.com/docs/messenger-platform/webhook-reference/account-linking
 *
 */
function receivedAccountLink(event) {
	var senderID = event.sender.id;
	var recipientID = event.recipient.id;

	var status = event.account_linking.status;
	var authCode = event.account_linking.authorization_code;

	console.log("Received account link event with for user %d with status %s " +
		"and auth code %s ", senderID, status, authCode);
}

/*
 * Delivery Confirmation Event
 *
 * This event is sent to confirm the delivery of a message. Read more about
 * these fields at https://developers.facebook.com/docs/messenger-platform/webhook-reference/message-delivered
 *
 */
function receivedDeliveryConfirmation(event) {
	var senderID = event.sender.id;
	var recipientID = event.recipient.id;
	var delivery = event.delivery;
	var messageIDs = delivery.mids;
	var watermark = delivery.watermark;
	var sequenceNumber = delivery.seq;

	if (messageIDs) {
		messageIDs.forEach(function (messageID) {
			console.log("Received delivery confirmation for message ID: %s",
				messageID);
		});
	}

	console.log("All message before %d were delivered.", watermark);
}

/*
 * Authorization Event
 *
 * The value for 'optin.ref' is defined in the entry point. For the "Send to
 * Messenger" plugin, it is the 'data-ref' field. Read more at
 * https://developers.facebook.com/docs/messenger-platform/webhook-reference/authentication
 *
 */
function receivedAuthentication(event) {
	var senderID = event.sender.id;
	var recipientID = event.recipient.id;
	var timeOfAuth = event.timestamp;

	// The 'ref' field is set in the 'Send to Messenger' plugin, in the 'data-ref'
	// The developer can set this to an arbitrary value to associate the
	// authentication callback with the 'Send to Messenger' click event. This is
	// a way to do account linking when the user clicks the 'Send to Messenger'
	// plugin.
	var passThroughParam = event.optin.ref;

	console.log("Received authentication for user %d and page %d with pass " +
		"through param '%s' at %d", senderID, recipientID, passThroughParam,
		timeOfAuth);

	// When an authentication is received, we'll send a message back to the sender
	// to let them know it was successful.
	sendTextMessage(senderID, "Authentication successful");
}

/*
 * Verify that the callback came from Facebook. Using the App Secret from
 * the App Dashboard, we can verify the signature that is sent with each
 * callback in the x-hub-signature field, located in the header.
 *
 * https://developers.facebook.com/docs/graph-api/webhooks#setup
 *
 */
function verifyRequestSignature(req, res, buf) {
	var signature = req.headers["x-hub-signature"];

	if (!signature) {
		throw new Error('Couldn\'t validate the signature.');
	} else {
		var elements = signature.split('=');
		var method = elements[0];
		var signatureHash = elements[1];

		var expectedHash = crypto.createHmac('sha1', config.FB_APP_SECRET)
			.update(buf)
			.digest('hex');

		if (signatureHash != expectedHash) {
			throw new Error("Couldn't validate the request signature.");
		}
	}
}

function isDefined(obj) {
	if (typeof obj == 'undefined') {
		return false;
	}

	if (!obj) {
		return false;
	}

	return obj != null;
}

// Spin up the server
app.listen(app.get('port'), function () {
	console.log('Server running on port', app.get('port'), '...');
})
