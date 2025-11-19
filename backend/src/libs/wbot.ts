import * as Sentry from "@sentry/node";
import makeWASocket, {
  WASocket,
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  isJidBroadcast,
  CacheStore
} from "baileys";
import makeWALegacySocket from "baileys";
import P from "pino";

import Whatsapp from "../models/Whatsapp";
import { logger } from "../utils/logger";
import MAIN_LOGGER from "baileys/lib/Utils/logger";
import authState from "../helpers/authState";
import { Boom } from "@hapi/boom";
import AppError from "../errors/AppError";
import { getIO } from "./socket";
import { Store } from "./store";
import { StartWhatsAppSession } from "../services/WbotServices/StartWhatsAppSession";
import DeleteBaileysService from "../services/BaileysServices/DeleteBaileysService";
import NodeCache from "node-cache";

const loggerBaileys = MAIN_LOGGER.child({});
loggerBaileys.level = "trace"; // LOG: aumentar nível para ver tudo

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
        const userDevicesCache: CacheStore = new NodeCache();

        // LOG: construção do socket
        logger.info(`Initializing WASocket for ${name}`);

        wsocket = makeWASocket({
          logger: loggerBaileys,
          printQRInTerminal: false,
          browser: Browsers.appropriate("Desktop"),
          auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, logger)
          },
          version,
          msgRetryCounterCache,
          shouldIgnoreJid: jid => isJidBroadcast(jid)
        });

        // LOG: Socket criado
        logger.info(`Baileys socket instance created for ${name}`);

        wsocket.ev.on(
          "connection.update",
          async ({ connection, lastDisconnect, qr }) => {
            // LOG: todas atualizações de conexão
            logger.info(
              `[Baileys][${name}] connection.update → ${connection || ""}`
            );

            if (lastDisconnect?.error) {
              logger.error(
                `[Baileys][${name}] lastDisconnect error: ${
                  (lastDisconnect.error as Boom)?.message
                }`
              );

              logger.error(
                `[Baileys][${name}] lastDisconnect full error: ${JSON.stringify(
                  lastDisconnect.error,
                  null,
                  2
                )}`
              );
            }

            if (connection === "close") {
              const statusCode = (lastDisconnect?.error as Boom)?.output
                ?.statusCode;

              logger.error(
                `[Baileys][${name}] Connection closed. Status code: ${statusCode}`
              );

              if (statusCode === 403) {
                logger.error(`[Baileys][${name}] BLOCKED BY WHATSAPP (403)`);

                await whatsapp.update({ status: "PENDING", session: "" });
                await DeleteBaileysService(whatsapp.id);
                io.to(`company-${whatsapp.companyId}-mainchannel`).emit(
                  `company-${whatsapp.companyId}-whatsappSession`,
                  {
                    action: "update",
                    session: whatsapp
                  }
                );
                removeWbot(id, false);
              }

              if (statusCode !== DisconnectReason.loggedOut) {
                logger.warn(
                  `[Baileys][${name}] Unexpected disconnect – reconnecting`
                );
                removeWbot(id, false);
                setTimeout(
                  () => StartWhatsAppSession(whatsapp, whatsapp.companyId),
                  2000
                );
              } else {
                logger.warn(
                  `[Baileys][${name}] Logged out. Cleaning state and restarting session`
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
                  `[Baileys][${name}] QR retries exceeded. Resetting session`
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
