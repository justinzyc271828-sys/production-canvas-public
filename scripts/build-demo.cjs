'use strict';

// Original synthetic picture and sound. FFmpeg is a build tool, not an app dependency.
const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { once } = require('node:events');
const { createHash } = require('node:crypto');

const root = path.resolve(__dirname, '..', 'demo');
const ffmpeg = process.env.FFMPEG || 'ffmpeg';
const fps = 24, width = 640, height = 360, sampleRate = 48000;
const cuts = [0, 96, 168, 216, 264, 300, 306, 312, 318, 324, 360, 420, 480, 540, 612, 672, 720];
const placeholders = [5, 6, 8];
const glyphs = {
  '0':['11111','10001','10011','10101','11001','10001','11111'],
  '1':['00100','01100','00100','00100','00100','00100','01110'],
  '2':['11110','00001','00001','11110','10000','10000','11111'],
  '3':['11110','00001','00001','01110','00001','00001','11110'],
  '4':['10010','10010','10010','11111','00010','00010','00010'],
  '5':['11111','10000','10000','11110','00001','00001','11110'],
  '6':['01111','10000','10000','11110','10001','10001','01110'],
  '7':['11111','00001','00010','00100','01000','01000','01000'],
  '8':['01110','10001','10001','01110','10001','10001','01110'],
  '9':['01110','10001','10001','01111','00001','00001','11110'],
  F:['11111','10000','10000','11110','10000','10000','10000'],
  R:['11110','10001','10001','11110','10100','10010','10001'],
  A:['01110','10001','10001','11111','10001','10001','10001'],
  M:['10001','11011','10101','10101','10001','10001','10001'],
  E:['11111','10000','10000','11110','10000','10000','11111'],
  S:['01111','10000','10000','01110','00001','00001','11110'],
  H:['10001','10001','10001','11111','10001','10001','10001'],
  O:['01110','10001','10001','10001','10001','10001','01110'],
  T:['11111','00100','00100','00100','00100','00100','00100']
};

function rectangle(buffer, x, y, w, h, color) {
  for (let row = Math.max(0, y); row < Math.min(height, y + h); row++) {
    for (let column = Math.max(0, x); column < Math.min(width, x + w); column++) {
      const offset = (row * width + column) * 3;
      buffer[offset] = color[0]; buffer[offset + 1] = color[1]; buffer[offset + 2] = color[2];
    }
  }
}

function text(buffer, label, x, y, scale) {
  for (const character of label) {
    const glyph = glyphs[character];
    if (glyph) for (let row = 0; row < 7; row++) for (let col = 0; col < 5; col++) {
      if (glyph[row][col] === '1') rectangle(buffer, x + col * scale, y + row * scale, scale, scale, [230,230,225]);
    }
    x += 6 * scale;
  }
}

function picture(frame) {
  const clip = cuts.findIndex((end, index) => index > 0 && frame < end) - 1;
  const colors = [[52,74,88],[76,83,64],[103,75,60],[71,67,92]];
  const color = colors[Math.floor(clip / 4)];
  const buffer = Buffer.alloc(width * height * 3);
  rectangle(buffer, 0, 0, width, height, color);
  rectangle(buffer, 28, 98, 584, 170, [18,20,22]);
  rectangle(buffer, 28, 312, Math.round(584 * frame / 719), 12, [192,178,148]);
  text(buffer, 'SHOT ' + String(clip + 1).padStart(2,'0'), 28, 30, 4);
  text(buffer, 'FRAME', 210, 112, 4);
  text(buffer, String(frame).padStart(4,'0'), 226, 164, 8);
  for (let bit=0;bit<10;bit++) {
    const white = (frame >> bit) & 1;
    rectangle(buffer, 28 + bit * 16, 280, 12, 12, white ? [240,240,240] : [8,8,8]);
  }
  return buffer;
}

function writeAudio(file) {
  const frames = sampleRate * cuts.at(-1) / fps;
  const data = Buffer.alloc(44 + frames * 4);
  data.write('RIFF'); data.writeUInt32LE(data.length - 8, 4); data.write('WAVEfmt ',8);
  data.writeUInt32LE(16,16); data.writeUInt16LE(1,20); data.writeUInt16LE(2,22);
  data.writeUInt32LE(sampleRate,24); data.writeUInt32LE(sampleRate*4,28);
  data.writeUInt16LE(4,32); data.writeUInt16LE(16,34); data.write('data',36); data.writeUInt32LE(frames*4,40);
  const notes = [220,261.6256,329.6276,293.6648];
  for (let i=0;i<frames;i++) {
    const time=i/sampleRate, beat=time*2, phase=beat%1;
    const melody=Math.sin(2*Math.PI*notes[Math.floor(beat/4)%4]*time)*.035;
    const click=Math.sin(2*Math.PI*(Math.floor(beat)%4===0?880:660)*time)*Math.exp(-phase*35)*.08;
    const value=Math.round((melody+click)*32767);
    data.writeInt16LE(value,44+i*4); data.writeInt16LE(value,46+i*4);
  }
  fs.writeFileSync(file,data);
}

async function main() {
  fs.mkdirSync(path.join(root,'media'),{recursive:true});
  fs.mkdirSync(path.join(root,'edit'),{recursive:true});
  writeAudio(path.join(root,'media/tone.wav'));
  const temporary=path.join(root,'media/sequence.build.mp4');
  const child=spawn(ffmpeg,['-hide_banner','-loglevel','error','-y','-f','rawvideo','-pix_fmt','rgb24','-s',width+'x'+height,
    '-r',String(fps),'-i','pipe:0','-i',path.join(root,'media/tone.wav'),'-c:v','libx264','-preset','fast','-crf','20',
    '-pix_fmt','yuv420p','-c:a','aac','-b:a','128k','-movflags','+faststart',temporary],{stdio:['pipe','ignore','inherit']});
  const completed=once(child,'exit');
  for (let frame=0;frame<cuts.at(-1);frame++) {
    if(!child.stdin.write(picture(frame))) await once(child.stdin,'drain');
  }
  child.stdin.end();
  const [code]=await completed;
  if(code!==0) throw Error('FFmpeg failed with '+code);
  fs.renameSync(temporary,path.join(root,'media/sequence.mp4'));
  execFileSync(ffmpeg,['-hide_banner','-loglevel','error','-y','-i',path.join(root,'media/sequence.mp4'),
    '-vf','trim=start_frame=264:end_frame=420,setpts=PTS-STARTPTS','-af','atrim=start=11:end=17.5,asetpts=PTS-STARTPTS',
    '-c:v','libx264','-crf','20','-c:a','aac',
    path.join(root,'media/focus.mp4')]);
  for (const index of placeholders) {
    execFileSync(ffmpeg,['-hide_banner','-loglevel','error','-y','-i',path.join(root,'media/sequence.mp4'),
      '-vf','select=eq(n\\,'+cuts[index]+')','-frames:v','1',path.join(root,'media/shot-'+(index+1)+'.png')]);
  }
  const clips=cuts.slice(0,-1).map((start,index)=>({clip_id:String(index+1),in:start/fps,out:cuts[index+1]/fps,position:start/fps,filters:[],shot:'S'+String(index+1).padStart(2,'0')}));
  const json={version:'1.0',name:'Original synthetic review exercise',
    profile:{fps_num:fps,fps_den:1,width,height},
    bin:[...clips.map((clip,index)=>({id:clip.clip_id,name:clip.shot,source:'../media/sequence.mp4',duration:30,type:'video'})),
      {id:'17',name:'Original pulse',source:'../media/tone.wav',duration:30,type:'audio'}],
    tracks:[{id:0,name:'画面',type:'video',clips},{id:1,name:'混音',type:'audio',clips:[{clip_id:'17',in:0,out:30,position:0,filters:[]}]}],
    transitions:[]};
  // CLI-Anything paths are project-root relative, whereas MLT paths are XML-file relative.
  const cli=structuredClone(json);
  for(const item of cli.bin) item.source=item.source.slice(3);
  fs.writeFileSync(path.join(root,'edit/sample.kdenlive-cli.json'),JSON.stringify(cli,null,2)+'\n');
  const properties = values => Object.entries(values)
    .map(([name, value]) => '<property name="' + name + '">' + value + '</property>').join('\n');
  const chains = json.bin.map(item => [
    '<chain id="source-' + item.id + '" in="0" out="719">',
    properties({
      resource: item.source,
      length: 720,
      'kdenlive:id': item.id,
      'kdenlive:clipname': item.name,
      video_index: item.type === 'audio' ? -1 : 0,
      audio_index: item.type === 'audio' ? 0 : -1,
      mlt_service: 'avformat'
    }),
    '</chain>'
  ].join('\n'));
  const entries = clips.map((clip, index) => [
    '<entry producer="source-' + clip.clip_id + '" in="' + cuts[index] + '" out="' + (cuts[index + 1] - 1) + '">',
    properties({ 'production_canvas:shot': clip.shot }),
    '</entry>'
  ].join('\n'));
  const sequence = '{0c744ea1-fc66-49e0-ab93-1ec5347efc15}';
  const xml = [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<mlt producer="main_bin">',
    '<profile width="640" height="360" frame_rate_num="24" frame_rate_den="1" progressive="1" display_aspect_num="16" display_aspect_den="9" sample_aspect_num="1" sample_aspect_den="1"/>',
    '<producer id="black" in="0" out="719">',
    properties({ resource: 'black', mlt_service: 'color', 'kdenlive:playlistid': 'black_track' }),
    '</producer>',
    ...chains,
    '<playlist id="video">',
    ...entries,
    '</playlist><playlist id="video-alt"/>',
    '<playlist id="audio">',
    properties({ 'kdenlive:audio_track': 1 }),
    '<entry producer="source-17" in="0" out="719"/>',
    '</playlist><playlist id="audio-alt"/>',
    '<tractor id="video-track">',
    properties({ 'kdenlive:track_name': '画面' }),
    '<track producer="video" hide="audio"/><track producer="video-alt" hide="audio"/>',
    '</tractor>',
    '<tractor id="audio-track">',
    properties({ 'kdenlive:track_name': '混音', 'kdenlive:audio_track': 1 }),
    '<track producer="audio" hide="video"/><track producer="audio-alt" hide="video"/>',
    '</tractor>',
    '<tractor id="' + sequence + '" in="0" out="719">',
    properties({
      'kdenlive:uuid': sequence,
      'kdenlive:sequenceproperties.documentuuid': sequence,
      'kdenlive:clipname': 'Review exercise',
      'kdenlive:sequenceproperties.tracksCount': 2,
      'kdenlive:duration': '00:00:30.000'
    }),
    '<track producer="black"/><track producer="video-track"/><track producer="audio-track"/>',
    '<transition>',
    properties({ mlt_service: 'mix', a_track: 0, b_track: 2, always_active: 1, sum: 1 }),
    '</transition></tractor>',
    '<playlist id="main_bin">',
    properties({
      'kdenlive:docproperties.version': '1.1',
      'kdenlive:docproperties.uuid': sequence,
      'kdenlive:docproperties.opensequences': sequence,
      'kdenlive:docproperties.activetimeline': sequence
    }),
    ...json.bin.map(item => '<entry producer="source-' + item.id + '" in="0" out="719"/>'),
    '</playlist>',
    '<tractor id="tractor_project">',
    properties({ 'kdenlive:projectTractor': 1 }),
    '<track producer="' + sequence + '"/>',
    '</tractor></mlt>'
  ].join('\n') + '\n';
  fs.writeFileSync(path.join(root,'edit/sample.kdenlive'),xml);
  const sha=file=>createHash('sha256').update(fs.readFileSync(path.join(root,file))).digest('hex');
  const review={timelineRevision:sha('edit/sample.kdenlive'),
    chapters:[{title:'认识画面',start:0,end:216,color:'#526c80'},{title:'短镜头练习',start:216,end:360,color:'#717753'},
      {title:'停帧与指令',start:360,end:540,color:'#9c7560'},{title:'回到全片',start:540,end:720,color:'#766485'}],
    shots:cuts.slice(0,-1).map((frame,index)=>({frame,title:'S'+String(index+1).padStart(2,'0')})),
    clips:clips.map((clip,index)=>({track:0,clip:index,shot:clip.shot,placeholder:placeholders.includes(index),
      ...(placeholders.includes(index)?{thumbnail:{path:'media/shot-'+(index+1)+'.png',sha256:sha('media/shot-'+(index+1)+'.png')}}:{})})),
    cues:[{frame:300,title:'连续短镜头'},{frame:420,title:'在这一帧记指令'},{frame:612,title:'对照节拍'}],
    sounds:[{frame:0,title:'原创建拍声'},{frame:360,title:'旋律变化'}],
    music:{bpm:120,beatsPerBar:4,start:0,end:720},
    sources:['Original programmatic picture and PCM audio in scripts/build-demo.cjs']};
  fs.writeFileSync(path.join(root,'review.json'),JSON.stringify(review,null,2)+'\n');
  const project={schema:'production-canvas/v1',title:'示例影片 · 审片练习',timeline:'edit/sample.kdenlive',
    video:{path:'media/sequence.mp4',label:'全片候选'},focus:{path:'media/focus.mp4',label:'短镜头练习',start:264,end:420},
    mix:'media/tone.wav',review:'review.json',notes:'README.md'};
  fs.writeFileSync(path.join(root,'project.json'),JSON.stringify(project,null,2)+'\n');
  fs.writeFileSync(path.join(root,'provenance.json'),JSON.stringify({generator:'scripts/build-demo.cjs',fps,frames:720,width,height,
    picture:'Original rectangle and bitmap-glyph drawing',audio:'Original generated sine tones',thirdPartyMedia:[],
    licensing:'Original demo media are covered by the repository Production Canvas Source License 1.0. Third-party software retains their own licenses.'},null,2)+'\n');
  console.log('Built 30-second, 16-clip original review sample.');
}
if (require.main === module) main().catch(error=>{console.error(error);process.exitCode=1;});
module.exports = { picture, cuts };
