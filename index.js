const express = require("express");
const admin = require("firebase-admin");
const path = "/etc/secrets/smartcollar-c69c1-firebase-adminsdk-fbsvc-9a523750d8.json";
const serviceAccount = require(path);

const app = express();
app.use(express.json());

const NOTIFICATION_COOLDOWN_MS = 1 * 60 * 1000; // 2 minutes
const REMINDER_CHECK_INTERVAL = 10 * 60 * 1000; 

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: "https://smartcollar-c69c1-default-rtdb.asia-southeast1.firebasedatabase.app"
});

/**
 * Helper functions
 */
async function shouldSendNotification(uid, petId, alertType) {
  try {
    const lastAlertRef = admin
      .database()
      .ref(`/users/${uid}/pets/${petId}/last_alerts/${alertType}`);
    const lastAlertSnap = await lastAlertRef.once("value");
    const lastAlertTime = lastAlertSnap.val();
    const now = Date.now();

    if (!lastAlertTime || now - lastAlertTime >= NOTIFICATION_COOLDOWN_MS) {
      await lastAlertRef.set(now);
      return true;
    }

    console.log(`Notification for ${alertType} skipped (cooldown)`);
    return false;
  } catch (error) {
    console.error("Error checking notification cooldown:", error);
    return true;
  }
}

async function resetAlertCooldown(uid, petId, alertType) {
  try {
    const lastAlertRef = admin
      .database()
      .ref(`/users/${uid}/pets/${petId}/last_alerts/${alertType}`);
    await lastAlertRef.remove();
    console.log(`Alert cooldown reset for ${alertType}`);
  } catch (error) {
    console.error("Error resetting alert cooldown:", error);
  }
}

async function sendPushNotification(uid, title, body, type = null, petId = null) {
  try {
    const timestamp = Date.now();
    const notifData = {
      title,
      message: body,
      timestamp,
      type: type || "alert",
      petId,
      source: "server"
    };

    // 1️⃣ Store notification in Realtime Database
    await admin.database().ref(`/users/${uid}/notifications`).push().set(notifData);

    // 2️⃣ Get device token
    const tokenSnap = await admin.database().ref(`/users/${uid}/deviceToken`).once("value");
    const token = tokenSnap.val();

    console.log(`Debug: Token for ${uid} is: ${token}`);

    if (!token) {
      console.log(`Skipping notification for ${uid}: No device token found.`);
      return;
    }

    // 3️⃣ Construct FCM payload (modern structure)
    const message = {
      tokens: [token],
      notification: {
        title: title,
        body: body,
      },
      android: {
        priority: "high",
        notification: {
          channelId: "smartcollar_channel",
          sound: "default",
        },
      },
      data: {
        type: type || "alert",
        petId: petId || "",
        timestamp: timestamp.toString(),
      },
    };

    // 4️⃣ Send notification using new method
    const response = await admin.messaging().sendEachForMulticast(message);

    console.log(`✅ Push notification sent to ${uid}:`, response.successCount, "success,", response.failureCount, "failure(s)");
  } catch (error) {
    console.error("❌ Error sending push notification:", error);
  }
}


function haversineDistance(lat1, lon1, lat2, lon2) {
  const toRad = (x) => (x * Math.PI) / 180;
  const R = 6371000;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

// Helper: check for due reminders
async function checkReminders() {
  console.log("⏱ Checking reminders at", new Date().toLocaleString());
  const usersSnap = await admin.database().ref("/users").once("value");
  const now = new Date();

  const todayStr = now.toISOString().split("T")[0]; // YYYY-MM-DD
  const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  const tomorrowStr = tomorrow.toISOString().split("T")[0];

  usersSnap.forEach(userSnap => {
    const uid = userSnap.key;
    userSnap.child("pets").forEach(petSnap => {
      const petId = petSnap.key;
      const remindersSnap = petSnap.child("reminders");

      remindersSnap.forEach(reminderSnap => {
        const reminder = reminderSnap.val();
        const reminderId = reminderSnap.key;

        if (reminder.completed) return; // skip completed reminders
        const reminderDate = new Date(reminder.date);
        const reminderDateStr = reminderDate.toISOString().split("T")[0];

        const oneHourBefore = new Date(reminderDate.getTime() - 60 * 60 * 1000);

        console.log(`🔔 Checking reminder ${reminderId} for ${uid}/${petId}: ${reminder.title} at ${reminder.date}`);

        // 1️⃣ 1-hour-before notification
        if (!reminder.oneHourNotifSent && now >= oneHourBefore && now < reminderDate) {
          console.log(`💡 Sending 1-hour-before notification for ${reminder.title}`);
          sendPushNotification(
            uid,
            `Reminder: ${reminder.title}`,
            `Your pet has an upcoming task in 1 hour: ${reminder.notes || ""}`,
            "reminder",
            petId
          );
          admin.database().ref(`/users/${uid}/pets/${petId}/reminders/${reminderId}/oneHourNotifSent`).set(true);
        }

        // 2️⃣ Same-day notification
        if (!reminder.dayNotifSent && todayStr === reminderDateStr) {
          console.log(`💡 Sending same-day notification for ${reminder.title}`);
          sendPushNotification(
            uid,
            `Reminder: ${reminder.title}`,
            `Today's task for your pet: ${reminder.notes || ""}`,
            "reminder",
            petId
          );
          admin.database().ref(`/users/${uid}/pets/${petId}/reminders/${reminderId}/dayNotifSent`).set(true);
        }

        // 3️⃣ Tomorrow notification
        if (!reminder.tomorrowNotifSent && tomorrowStr === reminderDateStr) {
          console.log(`💡 Sending tomorrow notification for ${reminder.title}`);
          sendPushNotification(
            uid,
            `Reminder: ${reminder.title}`,
            `Reminder for tomorrow: ${reminder.notes || ""}`,
            "reminder",
            petId
          );
          admin.database().ref(`/users/${uid}/pets/${petId}/reminders/${reminderId}/tomorrowNotifSent`).set(true);
        }
      });
    });
  });
}

setInterval(checkReminders, 10 * 60 * 1000);


/**
 * Threshold & Geofence Checks
 */
async function checkThreshold(uid, petId, type, value) {
  const settingsSnap = await admin.database().ref(`/users/${uid}/pets/${petId}/notification_settings`).once("value");
  const settings = settingsSnap.val();
  if (!settings) return;

  let alert = false;
  let message = "";
  let notifType = null;

  if (type === "bpm" && settings.heartRateAlert) {
    if (value > settings.maxHeartRate) { alert = true; notifType = "hr_high"; message = `Heart rate too high: ${value} bpm (max ${settings.maxHeartRate})`; }
    else if (value < settings.minHeartRate) { alert = true; notifType = "hr_low"; message = `Heart rate too low: ${value} bpm (min ${settings.minHeartRate})`; }
    else { await resetAlertCooldown(uid, petId, "hr_high"); await resetAlertCooldown(uid, petId, "hr_low"); }
  }

  if (type === "temperature" && settings.tempAlert) {
    if (value > settings.maxTemp) { alert = true; notifType = "temp_high"; message = `Temperature too high: ${value}°C (max ${settings.maxTemp}°C)`; }
    else if (value < settings.minTemp) { alert = true; notifType = "temp_low"; message = `Temperature too low: ${value}°C (min ${settings.minTemp}°C)`; }
    else { await resetAlertCooldown(uid, petId, "temp_high"); await resetAlertCooldown(uid, petId, "temp_low"); }
  }

  if (alert) {
    const shouldSend = await shouldSendNotification(uid, petId, notifType);
    if (shouldSend) await sendPushNotification(uid, `SmartCollar Alert: ${type}`, message, notifType, petId);
  }
}

async function checkGeofence(uid, petId, latitude, longitude) {
  try {
    const geoRef = admin.database().ref(`/users/${uid}/pets/${petId}/geofence`);
    const geoSnap = await geoRef.once("value");
    const geofence = geoSnap.val();

    if (!geofence) {
      console.log(`No geofence set for ${uid}/${petId}`);
      return;
    }

    console.log(`🐾 Checking geofence for ${petId}`);
    console.log(`Current: ${latitude}, ${longitude}`);
    console.log(`Fence center: ${geofence.latitude}, ${geofence.longitude} (radius: ${geofence.radius}m)`);

    const distance = haversineDistance(latitude, longitude, geofence.latitude, geofence.longitude);
    console.log(`📏 Distance from center: ${distance.toFixed(2)} meters`);

    if (distance > geofence.radius) {
      console.log(`⚠️ ${petId} is OUTSIDE the geofence!`);

      const shouldSend = await shouldSendNotification(uid, petId, "geofence");
      if (shouldSend) {
        await sendPushNotification(
          uid,
          "SmartCollar Alert: Geofence",
          `Your pet has left the safe zone! Distance: ${Math.round(distance)}m`,
          "geofence",
          petId
        );
      } else {
        console.log(`Notification skipped due to cooldown.`);
      }
    } else {
      console.log(`✅ ${petId} is INSIDE the geofence.`);
      await resetAlertCooldown(uid, petId, "geofence");
    }
  } catch (error) {
    console.error(`❌ Error checking geofence for ${uid}/${petId}:`, error);
  }
}



/**
 * Express endpoints
 */
app.get('/', (req, res) => res.send('SmartCollar API is running ✅'));

app.get('/testDB', async (req, res) => {
  try {
    const testRef = admin.database().ref('/users');
    const snapshot = await testRef.once('value');
    if (!snapshot.exists()) return res.status(404).json({ message: 'No data found at /users' });
    res.status(200).json(snapshot.val());
  } catch (error) {
    console.error('Error fetching data:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/testNotif', async (req, res) => {
  try {
    const { uid, petId } = req.query;
    if (!uid || !petId) return res.status(400).json({ error: 'Missing uid or petId' });

    const notifSettingRef = admin.database().ref(`users/${uid}/pets/${petId}/notification_settings`);
    const snapshot = await notifSettingRef.once('value');
    if (!snapshot.exists()) return res.status(404).json({ error: 'No notification settings found' });

    res.status(200).json(snapshot.val());
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});

app.post("/bpm", async (req, res) => {
  const { uid, petId, value } = req.body;
  await checkThreshold(uid, petId, "bpm", value);
  res.json({ status: "ok" });
});

app.post("/temperature", async (req, res) => {
  const { uid, petId, value } = req.body;
  await checkThreshold(uid, petId, "temperature", value);
  res.json({ status: "ok" });
});

app.post("/location", async (req, res) => {
  const { uid, petId, latitude, longitude } = req.body;
  await checkGeofence(uid, petId, latitude, longitude);
  res.json({ status: "ok" });
});

/**
 * Automatic Firebase listeners
 */
const db = admin.database();
const collarDataRef = db.ref("/users");

collarDataRef.on("child_added", (userSnap) => {
  const uid = userSnap.key;

  userSnap.child("pets").forEach((petSnap) => {
    const petId = petSnap.key;
    const collarRef = db.ref(`/users/${uid}/pets/${petId}/collar_data`);

    // BPM listener
    collarRef.child("bpm").on("value", (snapshot) => {
      const value = snapshot.val();
      if (value) {
        console.log(`📡 BPM update detected for ${uid}/${petId}: ${value}`);
        checkThreshold(uid, petId, "bpm", value);
      }
    });

    // Temperature listener
    collarRef.child("temperature").on("value", (snapshot) => {
      const value = snapshot.val();
      if (value) {
        console.log(`🌡️ Temp update detected for ${uid}/${petId}: ${value}`);
        checkThreshold(uid, petId, "temperature", value);
      }
    });

    // Location listener
    collarRef.child("location").on("value", (snapshot) => {
      const loc = snapshot.val();
      if (loc && loc.latitude && loc.longitude) {
        console.log(`📍 Location update for ${uid}/${petId}:`, loc);
        checkGeofence(uid, petId, loc.latitude, loc.longitude);
      }
    });
  });
});

/**
 * Start server
 */
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
