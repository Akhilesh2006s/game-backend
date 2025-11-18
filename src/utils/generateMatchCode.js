const alphabet = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';

let nanoidInstance = null;

const generateMatchCode = async () => {
  if (!nanoidInstance) {
    const { customAlphabet } = await import('nanoid');
    nanoidInstance = customAlphabet(alphabet, 6);
  }
  return nanoidInstance();
};

module.exports = generateMatchCode;

