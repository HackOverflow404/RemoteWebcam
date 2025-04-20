import * as functions from "firebase-functions";
import * as admin from "firebase-admin";

admin.initializeApp();
const db = admin.firestore();

export const generateCode = functions.https.onRequest(async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).send({ error: "Method Not Allowed" });
    return;
  }

  functions.logger.info("Generate Function: Request body:", { body: req.body });

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

  functions.logger.info("Delete Function: Request body:", { body: req.body });

  const { code } = req.body;
  if (!code) {
    res.status(400).send({ error: "Missing code" });
    return;
  }

  try {
    await db.collection("codes").doc(code).delete();
    res.status(200).json({ message: `Code ${code} deleted.` });
  } catch (error) {
    functions.logger.error("Error deleting code", {"error": error});
    res.status(500).json({ error: "Internal Server Error" });
  }
});

export const retrieveCode = functions.https.onRequest(async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method Not Allowed" });
    return;
  }

  functions.logger.info("Retrieve Function: Request body:", { body: req.body });

  let { code, offer, candidates, metadata } = req.body;

  code = (code || "").trim().toUpperCase();

  if (!code || typeof code !== "string" || code.length !== 5) {
    res.status(400).json({ error: "Invalid code format" });
    return;
  }

  if (!offer || typeof offer !== "object") {
    res.status(400).json({ error: "Missing or invalid SDP offer" });
    return;
  }

  if (!Array.isArray(candidates)) {
    res.status(400).json({ error: "Missing or invalid ICE candidates" });
    return;
  }

  try {
    const docRef = db.collection("codes").doc(code);
    const doc = await docRef.get();

    if (!doc.exists || !doc.data()) {
      res.status(404).json({ error: "Code not found" });
      return;
    }

    const data = doc.data();

    if (data.status !== "waiting") {
      res.status(403).json({ error: "Code already used or invalid" });
      return;
    }

    // Update the document with offer, ICE, and status
    await docRef.update({
      offer,
      candidates,
      metadata: metadata || null,
      status: "accepted",
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    res.status(200).json({
      success: true,
      message: "Offer and ICE candidates saved.",
    });
  } catch (error) {
    console.error("Error processing WebRTC data:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});