const tag = (block, name) => {
  const startTag = `<${name}>`;
  const endTag = `</${name}>`;
  const startIdx = block.indexOf(startTag);
  if (startIdx === -1) return '';
  const endIdx = block.indexOf(endTag, startIdx + startTag.length);
  if (endIdx === -1) return '';
  return block.substring(startIdx + startTag.length, endIdx).trim();
};

const block = "<name> John Doe </name>";
console.log(tag(block, 'name'));
