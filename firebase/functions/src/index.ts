import * as functions from "firebase-functions";
import * as admin from "firebase-admin";
import corsLib from "cors";

admin.initializeApp();
const db = admin.firestore();
const cors = corsLib({ origin: true });

// --- Shared Utilities ---

function sendError(res: any, code: number, message: string) {
  return res.status(code).json({ error: message });
}

function isValidCode(code: string): boolean {
  return typeof code === "string" && code.trim().length === 5;
}

async function getCodeDoc(code: string) {
  const docRef = db.collection("codes").doc(code.toUpperCase());
  const doc = await docRef.get();
  return { docRef, doc, data: doc.data() };
}

// --- Functions ---

export const generateCode = functions.https.onRequest((req, res) => {
  cors(req, res, async () => {
    try {
      if (req.method !== "POST") return sendError(res, 405, "Method Not Allowed");

      functions.logger.info("Generate Function: Request body:", { body: req.body });

      const charset = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
      let code: string;
      let exists = false;

      do {
        code = Array.from({ length: 5 }, () => charset[Math.floor(Math.random() * charset.length)]).join("");
        const doc = await db.collection("codes").doc(code).get();
        exists = doc.exists;
      } while (exists);

      await db.collection("codes").doc(code).set({
        timestamp: admin.firestore.Timestamp.now(),
        status: "waiting"
      });

      return res.status(200).json({ code });
    } catch (error) {
      functions.logger.error("Error in  function:", error);
      return sendError(res, 500, "Internal server error");
    }
  });
});

export const deleteCode = functions.https.onRequest((req, res) => {
  cors(req, res, async () => {
    try {
      if (req.method !== "POST") return sendError(res, 405, "Method Not Allowed");

      functions.logger.info("Delete Function: Request body:", { body: req.body });

      let { code } = req.body;
      code = (code || "").trim().toUpperCase();
      if (!code) return sendError(res, 400, "Missing code");
      if (!isValidCode(code)) return sendError(res, 400, "Invalid code format");
      
      await db.collection("codes").doc(code).delete();
      return res.status(200).json({ message: `Code ${code} deleted.` });
    } catch (error) {
      functions.logger.error("Error in  function:", error);
      return sendError(res, 500, "Internal server error");
    }
  });
});

export const validateCode = functions.https.onRequest((req, res) => { 
  cors(req, res, async () => {
    try {
      if (req.method !== "POST") {
        return sendError(res, 405, "Method not Allowed");
      }

      functions.logger.info("Validate Function: Request body:", {body: req.body});

      let { code } = req.body;
      code = (code || "").trim().toUpperCase();

      if (!code) return sendError(res, 400, "Missing code");
      if (!isValidCode(code)) return sendError(res, 400, "Invalid code format");

      const { doc, data } = await getCodeDoc(code);

      if (!doc.exists || !data) {
        return res.status(404).json({ 
          success: false,
          valid: false,
          message: "Code not found" 
        });
      }

      if (data.status !== "waiting") {
        return res.status(409).json({
          success: true,
          valid: false,
          message: "Code already used"
        });
      }

      return res.status(200).json({
        success: true,
        valid: true,
        message: "Code is valid"
      });
    } catch (error) {
      functions.logger.error("Error in validateCode function:", error);
      return sendError(res, 500, "Internal server error");
    }
  });
});

export const submitOffer = functions.https.onRequest((req, res) => {
  cors(req, res, async () => {
    try {
      if (req.method !== "POST") return sendError(res, 405, "Method Not Allowed");

      functions.logger.info("Submit Offer Function: Request body:", { body: req.body });

      let { code, offer, metadata } = req.body;
      code = (code || "").trim().toUpperCase();

      if (!isValidCode(code)) return sendError(res, 400, "Invalid code format");
      if (!offer || typeof offer !== "object") return sendError(res, 400, "Missing or invalid SDP offer");

      const { docRef, doc, data } = await getCodeDoc(code);

      if (!doc.exists || !data) return sendError(res, 404, "Code not found");
      if (data.status !== "waiting") return sendError(res, 409, "Code already used or invalid");

      await docRef.update({
        offer,
        metadata: metadata || null,
        status: "offered",
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      return res.status(200).json({ success: true, message: "Offer and ICE candidates saved" });
    } catch (error) {
      functions.logger.error("Error in submitOffer function:", error);
      return sendError(res, 500, "Internal server error");
    }
  });
});

export const checkOffer = functions.https.onRequest((req, res) => {
  cors(req, res, async () => {
    try {
      if (req.method !== "POST") return sendError(res, 405, "Method Not Allowed");

      functions.logger.info("Check Offer Function: Request body:", { body: req.body });
      let { code } = req.body;
      code = (code || "").trim().toUpperCase();

      if (!isValidCode(code)) return sendError(res, 400, "Invalid or missing code");

      const { doc, data } = await getCodeDoc(code);

      if (!doc.exists || !data) return sendError(res, 404, "Code not found");
      if (data.status !== "offered") return res.status(204).send();

      return res.status(200).json({
        offer: data.offer,
        candidates: data.candidates,
        metadata: data.metadata || null,
      });
    } catch (error) {
      functions.logger.error("Error in checkOffer function:", error);
      return sendError(res, 500, "Internal server error");
    }
  });
});

export const submitAnswer = functions.https.onRequest((req, res) => {
  cors(req, res, async () => {
    try {
      if (req.method !== "POST") return sendError(res, 405, "Method Not Allowed");

      let { code, answer, candidates } = req.body;
      code = (code || "").trim().toUpperCase();

      if (!code || !answer || typeof code !== "string") {
        return sendError(res, 400, "Missing required fields");
      }

      const { docRef, doc } = await getCodeDoc(code);

      if (!doc.exists) return sendError(res, 404, "Code not found");

      await docRef.update({
        answer,
        answerCandidates: candidates || [],
        status: "answered",
      });

      return res.status(200).json({ success: true });
    } catch (error) {
      functions.logger.error("Error in submitAnswer function:", error);
      return sendError(res, 500, "Internal server error");
    }
  });
});

export const checkAnswer = functions.https.onRequest((req, res) => {
  cors(req, res, async () => {
    try {
      if (req.method !== "POST") return sendError(res, 405, "Method Not Allowed");

      functions.logger.info("Check Answer Function: Request body:", { body: req.body });

      let { code } = req.body;
      code = (code || "").trim().toUpperCase();

      if (!isValidCode(code)) return sendError(res, 400, "Invalid or missing code");

      const { doc, data } = await getCodeDoc(code);

      if (!doc.exists || !data) return sendError(res, 404, "Code not found");
      if (data.status !== "answered") return res.status(204).send();

      return res.status(200).json({
        answer: data.answer,
        candidates: data.answerCandidates || [],
      });
    } catch (error) {
      functions.logger.error("Error in checkAnswer function:", error);
      return sendError(res, 500, "Internal server error");
    }
  });
});

export const updateOffer = functions.https.onRequest((req, res) => {
  cors(req, res, async () => {
    try {
      if (req.method !== "POST") return sendError(res, 405, "Method Not Allowed");

      functions.logger.info("Update Offer Function: Request body:", { body: req.body });

      let { code, offer, candidates, metadata } = req.body;
      code = (code || "").trim().toUpperCase();

      if (!isValidCode(code)) return sendError(res, 400, "Invalid code format");
      if (!offer || typeof offer !== "object") return sendError(res, 400, "Missing or invalid SDP offer");
      if (!Array.isArray(candidates)) return sendError(res, 400, "Missing or invalid ICE candidates");

      const { docRef, doc } = await getCodeDoc(code);

      if (!doc.exists) return sendError(res, 404, "Code not found");

      await docRef.update({
        offer,
        candidates,
        metadata: metadata || null,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      return res.status(200).json({ success: true, message: "Offer updated successfully" });
    } catch (error) {
      functions.logger.error("Error in updateOffer function:", error);
      return sendError(res, 500, "Internal server error");
    }
  });
});