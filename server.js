import express from "express";
import multer from "multer";
import fs from "fs";
import sharp from "sharp";
import { execSync } from "child_process";
import { PDFDocument } from "pdf-lib";

const app = express();
const upload = multer({ dest: "uploads/" });

function sizeKB(path){
  return fs.statSync(path).size / 1024;
}

// ---------- Ghostscript Normal Compression ----------
function ghostCompress(input, output){

 execSync(`gs -sDEVICE=pdfwrite \
 -dCompatibilityLevel=1.4 \
 -dPDFSETTINGS=/screen \
 -dNOPAUSE -dQUIET -dBATCH \
 -sOutputFile=${output} ${input}`);

}

// ---------- Extreme Compression ----------
async function extremeCompress(input, output, ratio){

 if(!fs.existsSync("temp_images")) fs.mkdirSync("temp_images");

 fs.readdirSync("temp_images").forEach(f=>{
  fs.unlinkSync(`temp_images/${f}`);
 });

 // Dynamic DPI
 let dpi = 72;

 if(ratio > 8) dpi = 40;
 else if(ratio > 5) dpi = 50;
 else if(ratio > 3) dpi = 60;

 execSync(`pdftoppm -jpeg -r ${dpi} ${input} temp_images/page`);

 const files = fs.readdirSync("temp_images")
  .filter(f => f.endsWith(".jpg"))
  .sort();

 const pdf = await PDFDocument.create();

 for(const f of files){

  const imgPath = `temp_images/${f}`;

  // Dynamic image resize
  let width = 900;
  let quality = 30;

  if(ratio > 8){
    width = 500;
    quality = 15;
  }
  else if(ratio > 5){
    width = 700;
    quality = 20;
  }
  else if(ratio > 3){
    width = 800;
    quality = 25;
  }

  const compressed = await sharp(imgPath)
   .resize({ width })
   .jpeg({ quality })
   .toBuffer();

  const img = await pdf.embedJpg(compressed);

  const page = pdf.addPage([img.width, img.height]);

  page.drawImage(img,{
    x:0,
    y:0,
    width:img.width,
    height:img.height
  });

 }

 const pdfBytes = await pdf.save();

 fs.writeFileSync(output,pdfBytes);

}

// ---------- Main API ----------
app.post("/compress", upload.single("file"), async (req,res)=>{

 try{

  const input = req.file.path;
  const output = `outputs/out-${Date.now()}.pdf`;

  const target = parseInt(req.body.target);

  if(!target) return res.status(400).send("Target size required");

  const original = sizeKB(input);

  const ratio = original / target;

  console.log("Original:",original,"Target:",target,"Ratio:",ratio);

  if(ratio > 2){

   console.log("Extreme compression");

   await extremeCompress(input,output,ratio);

  }else{

   console.log("Ghostscript compression");

   ghostCompress(input,output);

  }

  if(!fs.existsSync(output)){
   return res.status(500).send("Compression failed");
  }

  res.download(output);

 }catch(e){

  console.error(e);

  res.status(500).send("Compression error");

 }

});

// ---------- Status ----------
app.get("/",(req,res)=>{
 res.send("Smart PDF Compressor running");
});

app.listen(3000,()=>{
 console.log("Server running");
});
