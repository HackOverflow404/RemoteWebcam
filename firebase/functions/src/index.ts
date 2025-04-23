import * as functions from "firebase-functions";
import * as admin from "firebase-admin";
import corsLib from "cors";

admin.initializeApp();
const db = admin.firestore();

// REMINDER: Change to restrict in production
const cors = corsLib({ origin: true });




export const generateCode = functions.https.onRequest((req, res) => {
  cors(req, res, async () => {
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
});




export const deleteCode = functions.https.onRequest((req, res) => {
  cors(req, res, async () => {
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
      functions.logger.error("Error deleting code", { error });
      res.status(500).json({ error: "Internal Server Error" });
    }
  });
});




export const retrieveCode = functions.https.onRequest((req, res) => {
  cors(req, res, async () => {
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
      const data = doc.data();

      if (!doc.exists || !data) {
        res.status(404).json({ error: "Code not found" });
        return;
      }

      if (data.status !== "waiting") {
        res.status(403).json({ error: "Code already used or invalid" });
        return;
      }

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
});




export const checkCodeStatus = functions.https.onRequest(async (req, res) => {
  cors(req, res, async () => {
    if (req.method !== "POST") {
      res.status(405).json({ error: "Method Not Allowed" });
      return;
    }

    functions.logger.info("Check Code Status Function: Request body:", { body: req.body });

    const { code } = req.body;

    if (!code || typeof code !== "string" || code.length !== 5) {
      res.status(400).json({ error: "Invalid or missing code" });
      return;
    }

    try {
      const docRef = db.collection("codes").doc(code.toUpperCase());
      const doc = await docRef.get();
      const data = doc.data();

      if (!doc.exists || !data) {
        res.status(404).json({ error: "Code not found" });
        return;
      }


      if (data.status !== "accepted") {
        res.status(204).send();
        return;
      }

      res.status(200).json({
        offer: data.offer,
        candidates: data.candidates,
        metadata: data.metadata || null,
      });
    } catch (err) {
      console.error("Error checking code status:", err);
      res.status(500).json({ error: "Internal Server Error" });
    }
  });
});




export const submitAnswer = functions.https.onRequest(async (req, res) => {
  cors(req, res, async () => {
    if (req.method !== "POST") {
      res.status(405).json({ error: "Method Not Allowed" });
      return;
    }

    const { code, answer, candidates } = req.body;

    if (!code || !answer || typeof code !== "string") {
      res.status(400).json({ error: "Missing required fields" });
      return;
    }

    try {
      const docRef = db.collection("codes").doc(code.toUpperCase());
      const doc = await docRef.get();

      if (!doc.exists) {
        res.status(404).json({ error: "Code not found" });
        return;
      }

      await docRef.update({
        answer: answer,
        answerCandidates: candidates || [],
        status: "answered"
      });

      res.status(200).json({ success: true });
    } catch (error) {
      console.error("Error submitting answer:", error);
      res.status(500).json({ error: "Internal Server Error" });
    }
  });
});