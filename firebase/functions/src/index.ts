import * as functions from "firebase-functions";
import * as admin from "firebase-admin";

admin.initializeApp();

export const generateCode = functions.https.onRequest(async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).send({ error: "Method Not Allowed" });
    return;
  }

  const db = admin.firestore();
  const charset = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

  let code: string;
  let exists = false;

  do {
    code = Array.from({ length: 5 }, () =>
      charset[Math.floor(Math.random() * charset.length)]
    ).join("");
    const doc = await db.collection("codes").doc(code).get();
    exists = doc.exists;
  } while (exists);

  await db.collection("codes").doc(code).set({
    timestamp: admin.firestore.Timestamp.now(),
    status: "waiting"
  });

  res.status(200).json({ code });
});

export const deleteCode = functions.https.onRequest(async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).send({ error: "Method Not Allowed" });
    return;
  }

  const { code } = req.body;
  if (!code) {
    res.status(400).send({ error: "Missing code" });
    return;
  }

  try {
    await admin.firestore().collection("codes").doc(code).delete();
    res.status(200).json({ message: `Code ${code} deleted.` });
  } catch (error) {
    console.error("Error deleting code:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});