// Runs in a sandboxed renderer: data only, no filesystem or Node access.
module.exports = async function render(o) {
  const bytes=Uint8Array.from(atob(o.fontBase64), c=>c.charCodeAt(0));
  const face=await new FontFace('LocalTitle',bytes).load(); document.fonts.add(face);
  const canvas=document.createElement('canvas'); canvas.width=o.width; canvas.height=o.height;
  const c=canvas.getContext('2d'); c.clearRect(0,0,o.width,o.height);
  c.font=`${o['font-size']}px LocalTitle`; c.fillStyle=o.color; c.textAlign=o.align; c.textBaseline='alphabetic';
  const lines=o.text.split('\n'), step=o['font-size']*1.25;
  const metrics=lines.map(text=>c.measureText(text));
  const asc=Math.max(o['font-size'],...metrics.map(m=>m.actualBoundingBoxAscent));
  const desc=Math.max(o['font-size']*.25,...metrics.map(m=>m.actualBoundingBoxDescent));
  const height=asc+desc+(lines.length-1)*step;
  if(height>o.height-2*o.padding) throw new Error('Text overflow: height');
  const x=o.align==='left'?o.padding:o.align==='right'?o.width-o.padding:o.width/2;
  const top=(o.height-height)/2;
  const layout=lines.map((text,i)=>{
    const m=metrics[i], y=top+asc+i*step;
    const bounds={left:x-m.actualBoundingBoxLeft,right:x+m.actualBoundingBoxRight,top:y-m.actualBoundingBoxAscent,bottom:y+m.actualBoundingBoxDescent};
    if(m.width>o.width-2*o.padding || bounds.left<o.padding || bounds.right>o.width-o.padding || bounds.top<o.padding || bounds.bottom>o.height-o.padding) throw new Error('Text overflow: bounding box');
    c.fillText(text,x,y); return {x,y,width:m.width,bounds};
  });
  const pixels=c.getImageData(0,0,o.width,o.height).data;
  let transparent=0,ink=0; for(let i=3;i<pixels.length;i+=4) { if(pixels[i]===0) transparent++; else ink++; }
  if(!ink) throw new Error('No visible text pixels');
  return {png:canvas.toDataURL('image/png').split(',')[1],layout:{align:o.align,padding:o.padding,fontSize:o['font-size'],lineHeight:step,lines:layout},pixels:{transparent,ink}};
};
