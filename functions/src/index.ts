import { Response } from "express";
import { XMLParser } from "fast-xml-parser";
import * as admin from "firebase-admin";
import { onCall, onRequest } from "firebase-functions/v2/https";
import { onSchedule } from "firebase-functions/v2/scheduler";
import HTMLParser from "node-html-parser";
import { displayCom, getPrepTime, sortCommitmentsByTime } from "./commitment";
import { getWeekId, gregToOxDate } from "./date";
import { displayDuration, getDuration, getNow, isAwake } from "./time";
import { ApiRes, Commitment, Week, WikiWord } from "./types";

/** every 10 minutes */
const CRON = "0-50/10 * * * *";
const { TG_BOT_KEY, TG_CHAT_ID } = process.env;

admin.initializeApp({
  credential: admin.credential.applicationDefault(),
});

const db = admin.firestore();

const delay = (sec: number) =>
  new Promise<void>(res => setTimeout(() => res(), sec * 1000));

const post = (url: string, data: Record<string, unknown>) =>
  fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });

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
  async (req, res: Response<ApiRes>) => {
    try {
      const message_id = await notifyDefaultTokens({
        title: "vibrations",
      });
      res.status(200).json({
        status: 200,
        info: "Notification sent",
        result: { message_id },
      });
    } catch (err) {
      res.status(500).json({
        status: 500,
        info: "Error sending notification",
        error: `${err}`,
      });
    }
  }
);

type TgResult =
  | { ok: true; description?: string; result: Record<string, unknown> }
  | { ok: false; description: string; error_code: number };

const sendTg = async (text: string) => {
  const url = `https://api.telegram.org/bot${TG_BOT_KEY}/sendMessage`;
  const response = await post(url, {
    chat_id: TG_CHAT_ID,
    text,
    parse_mode: "Markdown",
  });
  const result = (await response.json()) as TgResult;
  if (result.ok) {
    return {
      status: response.status, // 200
      info: result.description ?? "TG sent",
      result: result.result,
    };
  } else {
    return {
      status: result.error_code,
      info: "Error from TG",
      error: result.description,
    };
  }
};

const comToTgText = (com: Commitment) => {
  const now = getNow().utcTime;
  const { title, description, location } = displayCom(com);
  const a = `*${title}*`;
  const b = description ? ` (${description})` : "";
  const c = location ? ` at ${location}` : "";
  const d = " in `" + displayDuration(now, com.time) + "`";
  return a + b + c + d;
};

const sendTgAlarm = async (): Promise<ApiRes> => {
  const today = gregToOxDate(getNow().utcDate);
  if (today === undefined) {
    throw new Error("Bad date");
  }
  const now = getNow().utcTime;
  const id = getWeekId(today);
  const doc = await db.collection("weeks").doc(id).get();
  const week = doc.data() as Week | undefined;
  const coms = week?.commitments ?? [];
  const todayComs = coms.filter(com => com.day === today.day);
  const first_com = sortCommitmentsByTime(todayComs)[0]?.com as
    | Commitment
    | undefined;
  if (week === undefined || first_com === undefined) {
    return { status: 200, info: "No commitments", result: {} };
  }
  const dur = getDuration(now, first_com.time);
  const firstComAlreadyStarted = dur === null;
  const { isPastLonNoon, wasActiveToday, utcLonNoon } = isAwake(week);
  if (firstComAlreadyStarted) {
    return {
      status: 200,
      info: "First commitment already started",
      result: { first_com },
    };
  }
  if (isPastLonNoon) {
    return {
      status: 200,
      info: "Past London noon",
      result: { utcNow: now, utcLonNoon },
    };
  }
  if (wasActiveToday) {
    return { status: 200, info: "Already active today", result: {} };
  }
  const timeUntilFirstCom = 60 * dur.hours + dur.mins;
  const prepTime = getPrepTime(first_com);
  const withinPrepTime = timeUntilFirstCom <= prepTime;
  if (!withinPrepTime) {
    return {
      status: 200,
      info: `No alarms yet; ${timeUntilFirstCom} minutes to go`,
      result: { first_com },
    };
  }
  const text = comToTgText(first_com);
  const tg_results: ApiRes[] = [];
  // TODO: use some kind of stream to send a response faster
  for (let i = 1; i <= 3; i++) {
    tg_results.push(await sendTg(text + ` \\[${i}/3]`));
    await delay(5);
  }
  const status = tg_results.every(res => res.status === 200) ? 200 : 500;
  return { status, info: "Sent alarms", result: { tg_results } };
};

export const alarm = onRequest(
  { region: "europe-west1" },
  async (req, res: Response<ApiRes>) => {
    try {
      const result = await sendTgAlarm();
      res.status(result.status).json(result);
    } catch (err) {
      console.log(err);
      res
        .status(500)
        .json({ status: 500, info: "Error sending alarm", error: `${err}` });
    }
  }
);

// const random = <T>(arr: T[]) => arr[Math.floor(Math.random() * arr.length)];

const getWord = async (): Promise<ApiRes<WikiWord>> => {
  try {
    const response = await fetch(
      "https://en.wiktionary.org//w/api.php?action=featuredfeed&feed=wotd&feedformat=atom"
    );
    const xml = await response.text();
    const parser = new XMLParser();
    const wiki_feed = parser.parse(xml) as WikiWord["wiki_feed"];
    // const entry = random(wiki_feed.feed.entry);
    const entry = wiki_feed.feed.entry.slice(-1)[0];
    const html = HTMLParser.parse(entry.summary);
    const title = html.getElementById("WOTD-rss-title");
    const word = title.innerText;
    const classification = title
      .closest("td")
      .childNodes.slice(1)
      .map(c => c.innerText)
      .join("")
      .trim();
    const definition = html
      .querySelectorAll(
        "#WOTD-rss-description > ol, #WOTD-rss-description > p:has(b)"
      )
      .map(c => c.outerHTML)
      .join(" ");
    return {
      status: 200,
      info: "Received word",
      result: { wiki_feed, word, classification, definition, url: entry.id },
    };
  } catch (err) {
    return { status: 500, info: "Error receiving word", error: `${err}` };
  }
};

// export const word = onRequest(
//   { region: "europe-west1" },
//   async (req, res: Response<ApiRes<Word>>) => {
//     const result = await getWord();
//     res.status(result.status).json(result);
//   }
// );

export const word = onCall(
  // { region: "europe-west1" },
  async (): Promise<ApiRes<WikiWord>> => {
    const result = await getWord();
    return result;
  }
);

export const schedule = onSchedule(
  { region: "europe-west1", schedule: CRON },
  async () => {
    console.log("Starting scheduled jobs...");
    try {
      const result = await sendTgAlarm();
      console.log("Scheduled jobs finished:", result.status, result.info);
    } catch (err) {
      console.log("Scheduled jobs failed:", err);
    }
  }
);
