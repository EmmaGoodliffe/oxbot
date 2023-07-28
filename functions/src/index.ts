// import { onSchedule } from "firebase-functions/v2/scheduler";
// import * as logger from "firebase-functions/logger";
import * as admin from "firebase-admin";
import { onRequest } from "firebase-functions/v2/https";
import { getWeekId, gregToOxDate, jsToGregDate } from "./date";
import { Week } from "./commitment";

// const CRON = "0-58/2 * * * *"; // every two minutes
const { TG_BOT_KEY, TG_CHAT_ID } = process.env;

admin.initializeApp({
  credential: admin.credential.applicationDefault(),
});

const db = admin.firestore();

const notifyDefaultTokens = async (notification: {
  title: string;
  body?: string;
}) => {
  const doc = await db.collection("tokens").doc("default").get();
  const data = doc.data() as { tokens: string[] } | undefined;
  const tokens = data?.tokens;
  const token = tokens && tokens.length && tokens.slice(-1)[0];
  if (!token) {
    console.log("No tokens");
    throw new Error("No tokens");
  }
  // TODO: change to `.sendEachForMulticast`
  return await admin.messaging().send({
    token,
    notification,
  });
};

export const notify = onRequest(
  { region: "europe-west1" },
  async (req, res) => {
    try {
      const result = await notifyDefaultTokens({
        title: "vibrations",
      });
      res.json({ status: "Notification sent", result });
    } catch (err) {
      res.status(500).json({ status: "Notification not sent", error: err });
    }
  }
);

const sendTg = async (text: string) => {
  const url = `https://api.telegram.org/bot${TG_BOT_KEY}/sendMessage?chat_id=${TG_CHAT_ID}&text=${text}`;
  const result = await fetch(url);
  return await result.json();
};

export const tg = onRequest({ region: "europe-west1" }, async (req, res) => {
  const text = req.params[0] ?? "No content";
  try {
    const result = await sendTg(text);
    res.json({ status: "TG sent", result });
  } catch (err) {
    res.status(500).json({ status: "TG not sent", error: err });
  }
});

export const summarise = onRequest(
  { region: "europe-west1" },
  async (req, res) => {
    const js = new Date();
    const greg = jsToGregDate(js);
    const today = gregToOxDate(greg);
    if (today === undefined) {
      res.status(500).json({ status: "Bad date" });
    } else {
      try {
        const id = getWeekId(today);
        const doc = await db.collection("weeks").doc(id).get();
        const data = doc.data() as Week | undefined;
        const coms = data?.commitments ?? [];
        const todayComs = coms.filter((com) => com.day === today.day);
        const text = todayComs.length
          ? todayComs.map((com) => `${com.type} at ${com.time}`).join(" | ")
          : "No commitments";
        const result = await sendTg(text);
        res.json({ status: "Summary sent", result });
      } catch (err) {
        res.status(500).json({ status: "Summary not sent", error: err });
      }
    }
  }
);

// export const sched = onSchedule(
//   { region: "europe-west1", schedule: CRON },
//   async e => {
//     console.log("SCHED SCHED SCHED");
//     logger.log("SCHED SCHED SCHED succeeded at", e.scheduleTime);
//   }
// );
