import * as Sentry from "@sentry/node";
import makeWASocket, {
  WASocket,
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  isJidBroadcast
} from "whaileys";
import makeWALegacySocket from "whaileys";
import P from "pino";

import Whatsapp from "../models/Whatsapp";
import { logger } from "../utils/logger";
import MAIN_LOGGER from "whaileys/lib/Utils/logger";
import authState from "../helpers/authState";
import { Boom } from "@hapi/boom";
import AppError from "../errors/AppError";
import { getIO } from "./socket";
import { Store } from "./store";
import { StartWhatsAppSession } from "../services/WbotServices/StartWhatsAppSession";
import DeleteBaileysService from "../services/BaileysServices/DeleteBaileysService";
import NodeCache from "node-cache";

//Ativa debug do Baileys
// process.env.DEBUG = "baileys*";

// const loggerBaileys = MAIN_LOGGER.child({});
// loggerBaileys.level = "trace";
// logger.info("Baileys TRACE logger activated");

//=====
type Session = WASocket & {
  id?: number;
  store?: Store;
};

const sessions: Session[] = [];

const retriesQrCodeMap = new Map<number, number>();

export const getWbot = (whatsappId: number): Session => {
  const sessionIndex = sessions.findIndex(s => s.id === whatsappId);

  if (sessionIndex === -1) {
    throw new AppError("ERR_WAPP_NOT_INITIALIZED");
  }
  return sessions[sessionIndex];
};

export const removeWbot = async (
  whatsappId: number,
  isLogout = true
): Promise<void> => {
  try {
    const sessionIndex = sessions.findIndex(s => s.id === whatsappId);
    if (sessionIndex !== -1) {
      if (isLogout) {
        sessions[sessionIndex].logout();
        sessions[sessionIndex].ws.close();
      }

      sessions.splice(sessionIndex, 1);
    }
  } catch (err) {
    logger.error(err);
  }
};

export const initWASocket = async (whatsapp: Whatsapp): Promise<Session> => {
  return new Promise(async (resolve, reject) => {
    try {
      (async () => {
        const io = getIO();

        const whatsappUpdate = await Whatsapp.findOne({
          where: { id: whatsapp.id }
        });

        if (!whatsappUpdate) return;

        const { id, name, provider } = whatsappUpdate;

        const { version, isLatest } = await fetchLatestBaileysVersion();

        logger.info(`Starting Baileys for session ${name}`);
        logger.info(
          `Baileys version: ${version.join(".")} | Latest: ${isLatest}`
        );
        logger.info(`Provider (legacy?): ${provider}`);

        let retriesQrCode = 0;
        let wsocket: Session = null;

        const { state, saveState } = await authState(whatsapp);

        const msgRetryCounterCache = new NodeCache();
        //const userDevicesCache: CacheStore = new NodeCache();

        logger.info(`Initializing WASocket for ${name}`);

        wsocket = makeWASocket({
          //logger: loggerBaileys,
          printQRInTerminal: false,
          browser: Browsers.appropriate("Desktop"),
          auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, logger)
          },
          version,
          //msgRetryCounterCache,
          shouldIgnoreJid: jid => isJidBroadcast(jid)
        });

        logger.info(`Baileys socket instance created for ${name}`);

        // 🔥🔥 LOGS DO WEBSOCKET INTERNO (ESSENCIAIS)
        if (wsocket?.ws) {
          wsocket.ws.on("open", () => {
            logger.info(`[Baileys][${name}] WS → OPEN`);
          });

          wsocket.ws.on("close", (code, reason) => {
            logger.error(
              `[Baileys][${name}] WS → CLOSE | code=${code} | reason=${reason?.toString()}`
            );
          });

          wsocket.ws.on("error", err => {
            logger.error(
              `[Baileys][${name}] WS → ERROR | ${err?.message || err}`
            );
          });

          wsocket.ws.on("unexpected-response", (req, res) => {
            logger.error(
              `[Baileys][${name}] WS → UNEXPECTED RESPONSE | HTTP ${res.statusCode}`
            );
          });
        }

        // 🔥 Início da escuta de eventos do Baileys
        wsocket.ev.on(
          "connection.update",
          async ({ connection, lastDisconnect, qr }) => {
            logger.info(
              `[Baileys][${name}] connection.update → ${connection || ""}`
            );

            if (lastDisconnect?.error) {
              const errorObj = lastDisconnect.error as Boom;

              logger.error(
                `[Baileys][${name}] lastDisconnect error: ${errorObj?.message}`
              );
              logger.error(
                `[Baileys][${name}] lastDisconnect full: ${JSON.stringify(
                  lastDisconnect.error,
                  null,
                  2
                )}`
              );
            }

            if (connection === "close") {
              // 🔥 Obtém o statusCode real
              let statusCode =
                (lastDisconnect?.error as Boom)?.output?.statusCode ||
                (lastDisconnect?.error as any)?.status ||
                (lastDisconnect?.error as any)?.code ||
                null;

              logger.error(
                `[Baileys][${name}] Connection closed. StatusCode → ${statusCode}`
              );

              if (statusCode === 403) {
                logger.error(`[Baileys][${name}] BLOCKED BY WHATSAPP (403)!`);

                await whatsapp.update({ status: "PENDING", session: "" });
                await DeleteBaileysService(whatsapp.id);

                io.to(`company-${whatsapp.companyId}-mainchannel`).emit(
                  `company-${whatsapp.companyId}-whatsappSession`,
                  { action: "update", session: whatsapp }
                );

                removeWbot(id, false);
              }

              if (statusCode !== DisconnectReason.loggedOut) {
                logger.warn(
                  `[Baileys][${name}] Unexpected disconnect — reconnecting...`
                );

                removeWbot(id, false);
                setTimeout(
                  () => StartWhatsAppSession(whatsapp, whatsapp.companyId),
                  2000
                );
              } else {
                logger.warn(
                  `[Baileys][${name}] Logged out. Resetting session...`
                );

                await whatsapp.update({ status: "PENDING", session: "" });
                await DeleteBaileysService(whatsapp.id);

                io.to(`company-${whatsapp.companyId}-mainchannel`).emit(
                  `company-${whatsapp.companyId}-whatsappSession`,
                  { action: "update", session: whatsapp }
                );

                removeWbot(id, false);
                setTimeout(
                  () => StartWhatsAppSession(whatsapp, whatsapp.companyId),
                  2000
                );
              }
            }

            if (connection === "open") {
              logger.info(`[Baileys][${name}] Connected successfully.`);

              await whatsapp.update({
                status: "CONNECTED",
                qrcode: "",
                retries: 0
              });

              io.to(`company-${whatsapp.companyId}-mainchannel`).emit(
                `company-${whatsapp.companyId}-whatsappSession`,
                { action: "update", session: whatsapp }
              );

              const sessionIndex = sessions.findIndex(
                s => s.id === whatsapp.id
              );

              if (sessionIndex === -1) {
                wsocket.id = whatsapp.id;
                sessions.push(wsocket);
              }

              resolve(wsocket);
            }

            if (qr !== undefined) {
              logger.warn(`[Baileys][${name}] New QR Code generated`);
              logger.warn(
                `[Baileys][${name}] QR retries: ${retriesQrCode + 1}`
              );

              if (retriesQrCodeMap.get(id) && retriesQrCodeMap.get(id) >= 3) {
                logger.error(
                  `[Baileys][${name}] Too many QR retries — resetting`
                );

                await whatsappUpdate.update({
                  status: "DISCONNECTED",
                  qrcode: ""
                });

                await DeleteBaileysService(whatsappUpdate.id);

                io.to(`company-${whatsapp.companyId}-mainchannel`).emit(
                  "whatsappSession",
                  { action: "update", session: whatsappUpdate }
                );

                wsocket.ev.removeAllListeners("connection.update");
                wsocket.ws.close();
                wsocket = null;
                retriesQrCodeMap.delete(id);
              } else {
                retriesQrCodeMap.set(id, (retriesQrCode += 1));

                await whatsapp.update({
                  qrcode: qr,
                  status: "qrcode",
                  retries: 0
                });

                const sessionIndex = sessions.findIndex(
                  s => s.id === whatsapp.id
                );
                if (sessionIndex === -1) {
                  wsocket.id = whatsapp.id;
                  sessions.push(wsocket);
                }

                io.to(`company-${whatsapp.companyId}-mainchannel`).emit(
                  `company-${whatsapp.companyId}-whatsappSession`,
                  { action: "update", session: whatsapp }
                );
              }
            }
          }
        );

        wsocket.ev.on("creds.update", () => {
          logger.info(`[Baileys][${name}] Credentials updated`);
          saveState();
        });
      })();
    } catch (error) {
      Sentry.captureException(error);
      console.log(error);
      reject(error);
    }
  });
};
