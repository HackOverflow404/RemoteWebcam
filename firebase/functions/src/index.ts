import * as functions from "firebase-functions";
import * as admin from "firebase-admin";

admin.initializeApp();

export const generateCode = functions.https.onRequest(async (req, res) => {
  // Optional: Restrict to POST requests
  if (req.method !== "POST") {
    res.status(405).send({ error: "Method Not Allowed" });
    return;
  }

  const db = admin.firestore();
  const charset = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

  let code: string;
  let exists = false;

  // Keep generating until a unique code is found
  do {
    code = Array.from({ length: 5 }, () =>
      charset[Math.floor(Math.random() * charset.length)]
    ).join("");
    const doc = await db.collection("codes").doc(code).get();
    exists = doc.exists;
  } while (exists);

  // Store the code with a timestamp and "waiting" status
  await db.collection("codes").doc(code).set({
    timestamp: admin.firestore.Timestamp.now(),
    status: "waiting"
  });

  // Send the response (but don't return it)
  res.status(200).json({ code });
});