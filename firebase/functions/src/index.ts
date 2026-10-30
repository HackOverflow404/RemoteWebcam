import * as functions from "firebase-functions";
import * as admin from "firebase-admin";
import { DocumentData, DocumentReference, DocumentSnapshot, FieldValue, Timestamp } from "firebase-admin/firestore";
import twilio from "twilio";
import dotenv from "dotenv";
import corsLib from "cors";
import { randomInt } from "crypto";

admin.initializeApp();
const db = admin.firestore();
const cors = corsLib({ origin: true });

dotenv.config();

// --- Shared Utilities ---

// No 0/O or 1/I: codes are read off a screen and typed on a phone.
const CODE_CHARSET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
// Abandoned codes (app crashed, never deleted) are garbage-collected by a
// Firestore TTL policy on `expiresAt`, and rejected once past it.
const CODE_TTL_MS = 24 * 60 * 60 * 1000;
// Long-poll cap; stays well under the 60s function timeout.
const MAX_WAIT_MS = 25_000;

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

function isExpired(data: DocumentData): boolean {
    const expiresAt = data.expiresAt as Timestamp | undefined;
    return !!expiresAt && expiresAt.toMillis() < Date.now();
}

async function createUniqueCode(extra: Record<string, unknown> = {}): Promise<string> {
    for (;;) {
        const code = Array.from({ length: 5 }, () => CODE_CHARSET[randomInt(CODE_CHARSET.length)]).join("");
        const now = Date.now();
        try {
            // create() fails if the doc exists, so two concurrent requests can
            // never be handed the same code.
            await db.collection("codes").doc(code).create({
                timestamp: Timestamp.fromMillis(now),
                expiresAt: Timestamp.fromMillis(now + CODE_TTL_MS),
                status: "waiting",
                ...extra,
            });
            return code;
        } catch (error: any) {
            if (error?.code !== 6 /* ALREADY_EXISTS */) throw error;
        }
    }
}

function clampWait(waitMs: unknown): number {
    const n = Number(waitMs);
    if (!Number.isFinite(n) || n <= 0) return 0;
    return Math.min(n, MAX_WAIT_MS);
}

/**
 * Resolve with the doc snapshot as soon as its status is one of `statuses` or
 * it is deleted, or with the latest snapshot after `waitMs`. Lets clients
 * long-poll instead of re-requesting every second, so the other side's update
 * reaches them within one Firestore round trip.
 */
function waitForStatus(
    docRef: DocumentReference,
    statuses: string[],
    waitMs: number,
    res: any,
): Promise<DocumentSnapshot> {
    return new Promise((resolve, reject) => {
        let latest: DocumentSnapshot | undefined;
        let settled = false;
        let unsubscribe = () => {};
        const finish = (err?: unknown) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            unsubscribe();
            if (latest) resolve(latest);
            else if (err) reject(err);
            else docRef.get().then(resolve, reject);
        };
        const timer = setTimeout(() => finish(), waitMs);
        // Client gave up (closed the connection); stop listening.
        res.on("close", () => finish());
        unsubscribe = docRef.onSnapshot((snap) => {
            latest = snap;
            if (!snap.exists || statuses.includes(snap.data()?.status)) finish();
        }, (err) => finish(err));
    });
}

// --- Functions ---
export const generateCode = functions.https.onRequest((req, res) => {
    cors(req, res, async () => {
        try {
            if (req.method !== "POST") return sendError(res, 405, "Method Not Allowed");

            const code = await createUniqueCode();
            functions.logger.info("Generated code", { code });

            return res.status(200).json({ code });
        } catch (error) {
            functions.logger.error("Error in generateCode function:", error);
            return sendError(res, 500, "Internal server error");
        }
    });
});

export const deleteCode = functions.https.onRequest((req, res) => {
    cors(req, res, async () => {
        try {
            if (req.method !== "POST") return sendError(res, 405, "Method Not Allowed");

            let { code } = req.body;
            code = (code || "").trim().toUpperCase();
            if (!code) return sendError(res, 400, "Missing code");
            if (!isValidCode(code)) return sendError(res, 400, "Invalid code format");
            
            await db.collection("codes").doc(code).delete();
            return res.status(200).json({ message: `Code ${code} deleted.` });
        } catch (error) {
            functions.logger.error("Error in deleteCode function:", error);
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

            if (isExpired(data)) {
                return res.status(410).json({
                    success: true,
                    valid: false,
                    message: "Code expired"
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

            let { code, offer, metadata } = req.body;
            code = (code || "").trim().toUpperCase();

            if (!isValidCode(code)) return sendError(res, 400, "Invalid code format");
            if (!offer || typeof offer !== "object" || typeof offer.sdp !== "string") {
                return sendError(res, 400, "Missing or invalid SDP offer");
            }
            functions.logger.info("Submit offer", { code });

            const docRef = db.collection("codes").doc(code);
            // Transaction so two phones racing on the same code can't both win.
            const outcome = await db.runTransaction(async (tx) => {
                const doc = await tx.get(docRef);
                const data = doc.data();
                if (!doc.exists || !data) return 404;
                if (isExpired(data)) return 410;
                if (data.status !== "waiting") return 409;
                tx.update(docRef, {
                    offer: { type: offer.type, sdp: offer.sdp },
                    metadata: metadata || null,
                    status: "offered",
                    updatedAt: FieldValue.serverTimestamp(),
                });
                return 200;
            });

            if (outcome === 404) return sendError(res, 404, "Code not found");
            if (outcome === 410) return sendError(res, 410, "Code expired");
            if (outcome === 409) return sendError(res, 409, "Code already used or invalid");

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

            let { code, waitMs } = req.body;
            code = (code || "").trim().toUpperCase();

            if (!isValidCode(code)) return sendError(res, 400, "Invalid or missing code");

            const docRef = db.collection("codes").doc(code);
            const wait = clampWait(waitMs);
            const doc = wait > 0
                ? await waitForStatus(docRef, ["offered"], wait, res)
                : await docRef.get();
            const data = doc.data();

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
            code = (typeof code === "string" ? code : "").trim().toUpperCase();

            if (!isValidCode(code)) return sendError(res, 400, "Invalid or missing code");
            if (!answer || typeof answer !== "object" || typeof answer.sdp !== "string") {
                return sendError(res, 400, "Missing or invalid SDP answer");
            }
            functions.logger.info("Submit answer", { code });

            const { docRef, doc, data } = await getCodeDoc(code);

            if (!doc.exists || !data) return sendError(res, 404, "Code not found");
            if (data.status !== "offered") return sendError(res, 409, "No pending offer for this code");

            await docRef.update({
                answer: { type: answer.type, sdp: answer.sdp },
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

            let { code, waitMs } = req.body;
            code = (code || "").trim().toUpperCase();

            if (!isValidCode(code)) return sendError(res, 400, "Invalid or missing code");

            const docRef = db.collection("codes").doc(code);
            const wait = clampWait(waitMs);
            const doc = wait > 0
                ? await waitForStatus(docRef, ["answered"], wait, res)
                : await docRef.get();
            const data = doc.data();

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
                updatedAt: FieldValue.serverTimestamp(),
            });

            return res.status(200).json({ success: true, message: "Offer updated successfully" });
        } catch (error) {
            functions.logger.error("Error in updateOffer function:", error);
            return sendError(res, 500, "Internal server error");
        }
    });
});

// Twilio tokens are valid for TOKEN_TTL_S; reuse one per instance for most of
// that window so clients skip a Twilio round trip (~300-800ms) on connect.
const TOKEN_TTL_S = 6 * 60 * 60;
const TOKEN_REUSE_MS = (TOKEN_TTL_S - 60 * 60) * 1000;
let cachedIceServers: { servers: unknown; fetchedAt: number } | null = null;
let twilioClient: ReturnType<typeof twilio> | null = null;

export const getTurnCredentials = functions.https.onRequest((req, res) => {
    cors(req, res, async () => {
        try {
            if (req.method !== "POST") return sendError(res, 405, "Method Not Allowed");

            if (!cachedIceServers || Date.now() - cachedIceServers.fetchedAt > TOKEN_REUSE_MS) {
                twilioClient ??= twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
                const token = await twilioClient.tokens.create({ ttl: TOKEN_TTL_S });
                cachedIceServers = { servers: token.iceServers, fetchedAt: Date.now() };
            }

            return res.status(200).json(cachedIceServers.servers);
        } catch (error) {
            functions.logger.error("Error in getTurnCredentials function:", error);
            return sendError(res, 500, "Internal server error");
        }
    });
});

export const generateCodePushURL = functions.https.onRequest((req, res) => {
    cors(req, res, async () => {
        try {
            if (req.method !== "POST") return sendError(res, 405, "Method Not Allowed");

            
            let { url } = req.body;
            url = (url || "").trim();
            if (!url) return sendError(res, 400, "Missing URL");

            const code = await createUniqueCode({ url });

            return res.status(200).json({ code });
        } catch (error) {
            functions.logger.error("Error in generateCodePushURL function:", error);
            return sendError(res, 500, "Internal server error");
        }
    });
});

export const getURL = functions.https.onRequest((req, res) => {
    cors(req, res, async () => {
        try {
            if (req.method !== "POST") return sendError(res, 405, "Method Not Allowed");

            let { code } = req.body;
            code = (code || "").trim().toUpperCase();
            if (!code) return sendError(res, 400, "Missing code");
            if (!isValidCode(code)) return sendError(res, 400, "Invalid code format");

            const { doc, data } = await getCodeDoc(code);
            if (!doc.exists || !data) {
                return res.status(404).json({ 
                    success: false,
                    message: "Code not found" 
                });
            }
            if (data.status !== "waiting") {
                return res.status(409).json({
                    success: false,
                    message: "Code already used or invalid"
                });
            }

            return res.status(200).json({
                url: data.url,
            });
        } catch (error) {
            functions.logger.error("Error in getURL function:", error);
            return sendError(res, 500, "Internal server error");
        }
    });
});