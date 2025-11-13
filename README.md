const getContactMessage = async (msg: proto.IWebMessageInfo, wbot: Session) => {
const isGroup = msg.key.remoteJid.includes("g.us");
let contact = {};
const rawNumber = msg.key.remoteJid.replace(/\D/g, "");

contact.id = msg.key.remoteJid;
contact.name = msg.key.fromMe ? rawNumber : msg.pushName;
contact.isGroup = isGroup;

// if (msg.key.remoteJid.includes("g.us")) {
// contact.lid = msg.key.participant;
// contact.number = msg.key.participantPn.replace(/\D/g, "");
// }

if (msg.key.remoteJid.includes("@lid")) {
contact.lid = msg.key.remoteJid;
}
if (msg.key.senderPn) {
contact.number = msg.key.senderPn.replace(/\D/g, "");
}
if (msg.key.remoteJid.includes("@s.whatsapp.net")) {
contact.remoteJid = msg.key.remoteJid;
contact.number = msg.key.remoteJid.replace(/\D/g, "");
}

return contact;
};
