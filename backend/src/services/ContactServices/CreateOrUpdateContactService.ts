import { getIO } from "../../libs/socket";
import Contact from "../../models/Contact";
import ContactCustomField from "../../models/ContactCustomField";
import { isNil } from "lodash";
import { Op } from "sequelize"; // ? NOVO IMPORT
interface ExtraInfo extends ContactCustomField {
  name: string;
  value: string;
}

interface Request {
  name: string;
  number: string;
  isGroup: boolean;
  email?: string;
  profilePicUrl?: string;
  companyId: number;
  extraInfo?: ExtraInfo[];
  whatsappId?: number;
  remoteJid?: string;
  lid?: string; // ? NOVO CAMPO
}

const CreateOrUpdateContactService = async ({
  name,
  number,
  profilePicUrl,
  isGroup,
  email = "",
  companyId,
  extraInfo = [],
  whatsappId,
  remoteJid,
  lid // ? NOVO PARÂMETRO
}: Request): Promise<Contact> => {
  const io = getIO();

  const whereConditions: any[] = [];
  if (number) whereConditions.push({ number, companyId });
  if (lid) whereConditions.push({ lid, companyId });

  if (whereConditions.length === 0) {
    throw new Error(
      "Nem number nem lid foram fornecidos para busca de contato"
    );
  }

  let contact = await Contact.findOne({
    where: { [Op.or]: whereConditions }
  });

  if (contact) {
    const updates: any = {};
    //console.log("CreateOrUpdate: ", remoteJid, contact.remoteJid);
    // Atualiza LID somente se antes era null
    if (remoteJid !== contact.remoteJid) {
      updates.remoteJid = remoteJid;
    }
    // Atualiza LID somente se antes era null
    if (lid && !contact.lid) {
      updates.lid = lid;
    }

    // Atualiza profilePicUrl
    if (profilePicUrl !== contact.profilePicUrl) {
      updates.profilePicUrl = profilePicUrl;
    }

    // Atualiza whatsappId se não existir
    if (isNil(contact.whatsappId)) {
      updates.whatsappId = whatsappId;
    }

    // Só chama update se houver algo pra atualizar
    if (Object.keys(updates).length > 0) {
      console.log("🟢 Contato Atualizado:", updates);
      await contact.update(updates);
    }

    io.to(`company-${companyId}-mainchannel`).emit(
      `company-${companyId}-contact`,
      {
        action: "update",
        contact
      }
    );
  } else {
    // Criar novo contato
    contact = await Contact.create({
      name,
      number,
      profilePicUrl,
      email,
      isGroup,
      extraInfo,
      companyId,
      whatsappId,
      remoteJid,
      lid
    });

    io.to(`company-${companyId}-mainchannel`).emit(
      `company-${companyId}-contact`,
      {
        action: "create",
        contact
      }
    );
  }

  return contact;
};

export default CreateOrUpdateContactService;
