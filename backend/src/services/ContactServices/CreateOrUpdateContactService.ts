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

  console.log(remoteLid, "->", !contact.lid);
  if (remoteLid && !contact.lid) {
    contact.update({ remoteLid });
  }

  if (contact) {
    contact.update({ profilePicUrl });
    console.log(contact.whatsappId);
    if (isNil(contact.whatsappId)) {
      contact.update({
        whatsappId
      });
    }

    io.to(`company-${companyId}-mainchannel`).emit(
      `company-${companyId}-contact`,
      {
        action: "update",
        contact
      }
    );
  } else {
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
      lid // ? NOVO CAMPO
    });

    io.to(`company-${companyId}-mainchannel`).emit(
      `company-${companyId}-contact`,
      {
        action: "create",
        contact
      }
    );
  }
  //console.log("CreateOrUpdateContactService: ", contact);
  return contact;
};

export default CreateOrUpdateContactService;
