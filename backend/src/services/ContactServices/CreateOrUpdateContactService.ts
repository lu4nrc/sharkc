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
  lid: remoteLid // ? NOVO PARÂMETRO
}: Request): Promise<Contact> => {
  const io = getIO();

  const whereConditions: any[] = [];
  if (number) whereConditions.push({ number, companyId });
  if (remoteLid) whereConditions.push({ remoteLid, companyId });

  if (whereConditions.length === 0) {
    throw new Error(
      "Nem number nem lid foram fornecidos para busca de contato"
    );
  }

  let contact = await Contact.findOne({
    where: { [Op.or]: whereConditions }
  });

  if (contact) {
    // Atualiza LID somente se antes era null
    if (remoteLid && !contact.lid) {
      await contact.update({ lid: remoteLid });
    }

    // Atualiza profile
    if (profilePicUrl) {
      await contact.update({ profilePicUrl });
    }

    // Atualiza whatsappId se não existir
    if (isNil(contact.whatsappId)) {
      await contact.update({ whatsappId });
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
      lid: remoteLid
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
