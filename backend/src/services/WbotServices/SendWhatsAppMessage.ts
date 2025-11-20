import { WAMessage } from "whaileys";
import WALegacySocket from "whaileys";
import * as Sentry from "@sentry/node";
import AppError from "../../errors/AppError";
import GetTicketWbot from "../../helpers/GetTicketWbot";
import Message from "../../models/Message";
import Ticket from "../../models/Ticket";

import formatBody from "../../helpers/Mustache";
import Contact from "../../models/Contact";

interface Request {
  body: string;
  ticket: Ticket;
  quotedMsg?: Message;
}

const SendWhatsAppMessage = async ({
  body,
  ticket,
  quotedMsg
}: Request): Promise<WAMessage> => {
  const wbot = await GetTicketWbot(ticket);
  const contact = await Contact.findByPk(ticket.contactId);

  if (!contact) {
    throw new AppError("Contato não encontrado para envio de mensagem");
  }

  let jid: string;

  if (ticket.isGroup) {
    jid = `${contact.number}@g.us`;
  } else if (contact.remoteJid) {
    jid = contact.remoteJid;
  } else {
    jid = `${contact.number}@s.whatsapp.net`;
  }

  let options: any = {};
  if (quotedMsg) {
    const chatMessage = await Message.findOne({ where: { id: quotedMsg.id } });
    if (chatMessage) {
      const msgFound = JSON.parse(chatMessage.dataJson);
      options = {
        quoted: {
          key: msgFound.key,
          message: {
            extendedTextMessage: msgFound.message.extendedTextMessage
          }
        }
      };
    }
  }

  try {
    const sentMessage = await wbot.sendMessage(
      jid,
      {
        text: formatBody(body, contact)
      },
      options
    );

    await ticket.update({ lastMessage: formatBody(body, contact) });
    return sentMessage;
  } catch (err: any) {
    Sentry.captureException(err);
    console.error("❌ Erro ao enviar mensagem:", err.message);
    throw new AppError("ERR_SENDING_WAPP_MSG");
  }
};

export default SendWhatsAppMessage;
