import express from "express";
import multer from "multer";
import { execSync } from "child_process";
import fs from "fs";
import sharp from "sharp";
import { PDFDocument } from "pdf-lib";

const app = express();
const upload = multer({ dest: "uploads/" });

function sizeKB(path) {
  return fs.statSync(path).size / 1024;
}

// ---------- Ghostscript Compression ----------
function ghostCompress(input, output) {

  execSync(`gs -sDEVICE=pdfwrite \
-dCompatibilityLevel=1.4 \
-dPDFSETTINGS=/screen \
-dNOPAUSE -dQUIET -dBATCH \
-sOutputFile=${output} ${input}`);

}

// ---------- Extreme Compression ----------
async function extremeCompress(input, output) {

  // clean temp_images
  if (!fs.existsSync("temp_images")) fs.mkdirSync("temp_images");

  fs.readdirSync("temp_images").forEach(f => {
    fs.unlinkSync(`temp_images/${f}`);
  });

  // PDF → JPEG images
  execSync(`pdftoppm -jpeg ${input} temp_images/page`);

  const files = fs.readdirSync("temp_images")
    .filter(f => f.endsWith(".jpg"))
    .sort();

  if (files.length === 0) {
    throw new Error("Image conversion failed");
  }

  const pdf = await PDFDocument.create();

  for (const f of files) {

    const imgPath = `temp_images/${f}`;

    const compressed = await sharp(imgPath)
      .jpeg({ quality: 40 })
      .toBuffer();

    const img = await pdf.embedJpg(compressed);

    const page = pdf.addPage([img.width, img.height]);

    page.drawImage(img, {
      x: 0,
      y: 0,
      width: img.width,
      height: img.height
    });

  }

  const pdfBytes = await pdf.save();

  fs.writeFileSync(output, pdfBytes);
}

// ---------- Main API ----------
app.post("/compress", upload.single("file"), async (req, res) => {

  try {

    const input = req.file.path;
    const output = `outputs/out-${Date.now()}.pdf`;

    const target = parseInt(req.body.target);

    if (!target) {
      return res.status(400).send("Target size required");
    }

    const original = sizeKB(input);

    const ratio = original / target;

    console.log("Original:", original, "Target:", target, "Ratio:", ratio);

    if (ratio > 5) {

      console.log("Using EXTREME compression");

      await extremeCompress(input, output);

    } else {

      console.log("Using NORMAL compression");

      ghostCompress(input, output);

    }

    if (!fs.existsSync(output)) {
      return res.status(500).send("Compression failed");
    }

    res.download(output);

  } catch (err) {

    console.error(err);

    res.status(500).send("Compression error");

  }

});

// ---------- Status Route ----------
app.get("/", (req, res) => {

  res.send("Smart PDF Compressor running");

});

app.listen(3000, () => {

  console.log("Server running on port 3000");

});
