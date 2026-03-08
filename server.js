import express from "express";
import multer from "multer";
import { execSync } from "child_process";
import fs from "fs";
import sharp from "sharp";
import { PDFDocument } from "pdf-lib";

const app = express();
const upload = multer({ dest: "uploads/" });

function sizeKB(path){
 return fs.statSync(path).size / 1024;
}

// -------- GHOSTSCRIPT NORMAL MODE --------
function ghostCompress(input, output){
 execSync(`gs -sDEVICE=pdfwrite \
 -dCompatibilityLevel=1.4 \
 -dPDFSETTINGS=/screen \
 -dNOPAUSE -dQUIET -dBATCH \
 -sOutputFile=${output} ${input}`);
}

// -------- EXTREME MODE --------
async function extremeCompress(input, output){

 // PDF → images
 execSync(`pdftoppm -jpeg ${input} temp_images/page`);

 const files = fs.readdirSync("temp_images");

 const pdf = await PDFDocument.create();

 for(const f of files){

   const imgPath = `temp_images/${f}`;

   const compressed = await sharp(imgPath)
      .jpeg({ quality:40 })
      .toBuffer();

   const img = await pdf.embedJpg(compressed);

   const page = pdf.addPage([img.width,img.height]);

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

// -------- MAIN API --------
app.post("/compress", upload.single("file"), async (req,res)=>{

 const input = req.file.path;
 const output = `outputs/out-${Date.now()}.pdf`;

 const target = parseInt(req.body.target);

 const original = sizeKB(input);

 const ratio = original / target;

 if(ratio > 5){

   await extremeCompress(input,output);

 }else{

   ghostCompress(input,output);

 }

 res.download(output);

});

app.listen(3000,()=>{
 console.log("Smart PDF Compressor running");
});
