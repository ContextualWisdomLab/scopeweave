with open("cloud-sync.js", "r") as f:
    lines = f.readlines()

new_lines = []
in_tag = False
for line in lines:
    if "const tag = (block, name) => {" in line:
        new_lines.append(line)
        new_lines.append("    const startTag = `<${name}>`;\n")
        new_lines.append("    const endTag = `</${name}>`;\n")
        new_lines.append("    const startIdx = block.indexOf(startTag);\n")
        new_lines.append("    if (startIdx === -1) return '';\n")
        new_lines.append("    const endIdx = block.indexOf(endTag, startIdx + startTag.length);\n")
        new_lines.append("    if (endIdx === -1) return '';\n")
        new_lines.append("    return block.substring(startIdx + startTag.length, endIdx).trim();\n")
        in_tag = True
    elif in_tag and "};" in line:
        new_lines.append(line)
        in_tag = False
    elif not in_tag:
        new_lines.append(line)

with open("cloud-sync.js", "w") as f:
    f.writelines(new_lines)
