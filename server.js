const express=require("express");
const http=require("http");
const {Server}=require("socket.io");
const path=require("path");
const sqlite3=require("sqlite3").verbose();
const crypto=require("crypto");

const app=express(), server=http.createServer(app), io=new Server(server);
const PORT=process.env.PORT||3000;
const db=new sqlite3.Database(process.env.DB_PATH||path.join(__dirname,"wecsord.db"));
app.use(express.json({limit:"5mb"}));
app.use(express.static(path.join(__dirname,"..","public")));

db.serialize(()=>{
 db.run(`CREATE TABLE IF NOT EXISTS users(
   id INTEGER PRIMARY KEY AUTOINCREMENT,
   username TEXT UNIQUE NOT NULL,
   display_name TEXT NOT NULL,
   password_hash TEXT NOT NULL,
   salt TEXT NOT NULL,
   avatar TEXT DEFAULT '',
   about TEXT DEFAULT '',
   game TEXT DEFAULT '',
   created_at TEXT DEFAULT CURRENT_TIMESTAMP
 )`);
 db.run(`CREATE TABLE IF NOT EXISTS sessions(
   token TEXT PRIMARY KEY,
   user_id INTEGER NOT NULL,
   created_at TEXT DEFAULT CURRENT_TIMESTAMP
 )`);
});

function hashPassword(password,salt){
 return crypto.scryptSync(password,salt,64).toString("hex");
}
function token(){return crypto.randomBytes(32).toString("hex")}
function validUsername(u){return /^[A-Za-z][A-Za-z0-9_]{2,19}$/.test(u)}
function safeUser(r){return {id:r.id,username:r.username,displayName:r.display_name,avatar:r.avatar||"",about:r.about||"",game:r.game||""}}
function auth(req,res,next){
 const t=(req.headers.authorization||"").replace(/^Bearer\s+/,"");
 if(!t)return res.status(401).json({error:"Необходим вход"});
 db.get(`SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=?`,[t],(e,row)=>{
   if(e||!row)return res.status(401).json({error:"Сессия истекла"});
   req.user=row;next();
 });
}

app.post("/api/register",(req,res)=>{
 const username=String(req.body.username||"").trim();
 const display=String(req.body.displayName||username).trim().slice(0,30)||username;
 const password=String(req.body.password||"");
 if(!validUsername(username))return res.status(400).json({error:"Username: только английские буквы, цифры и _, 3–20 символов. Первый символ — буква."});
 if(password.length<6)return res.status(400).json({error:"Пароль должен быть не короче 6 символов."});
 const salt=crypto.randomBytes(16).toString("hex"), hash=hashPassword(password,salt);
 db.run(`INSERT INTO users(username,display_name,password_hash,salt) VALUES(?,?,?,?)`,[username,display,hash,salt],function(e){
   if(e)return res.status(409).json({error:"Этот username уже занят."});
   db.get(`SELECT * FROM users WHERE id=?`,[this.lastID],(e,row)=>{
     const t=token();db.run(`INSERT INTO sessions(token,user_id) VALUES(?,?)`,[t,row.id]);
     res.json({token:t,user:safeUser(row)});
   });
 });
});
app.post("/api/login",(req,res)=>{
 const username=String(req.body.username||"").trim(), password=String(req.body.password||"");
 db.get(`SELECT * FROM users WHERE username=?`,[username],(e,row)=>{
   if(e||!row||hashPassword(password,row.salt)!==row.password_hash)return res.status(401).json({error:"Неверный username или пароль."});
   const t=token();db.run(`INSERT INTO sessions(token,user_id) VALUES(?,?)`,[t,row.id]);
   res.json({token:t,user:safeUser(row)});
 });
});
app.get("/api/me",auth,(req,res)=>res.json({user:safeUser(req.user)}));
app.patch("/api/me",auth,(req,res)=>{
 const display=String(req.body.displayName||req.user.display_name).trim().slice(0,30)||req.user.display_name;
 const avatar=String(req.body.avatar||"").slice(0,2_000_000);
 const about=String(req.body.about||"").slice(0,300);
 const game=String(req.body.game||"").slice(0,80);
 db.run(`UPDATE users SET display_name=?,avatar=?,about=?,game=? WHERE id=?`,[display,avatar,about,game,req.user.id],e=>{
   if(e)return res.status(500).json({error:"Не удалось сохранить профиль."});
   db.get(`SELECT * FROM users WHERE id=?`,[req.user.id],(e,row)=>res.json({user:safeUser(row)}));
 });
});
app.post("/api/logout",auth,(req,res)=>{
 const t=(req.headers.authorization||"").replace(/^Bearer\s+/,"");
 db.run(`DELETE FROM sessions WHERE token=?`,[t]);res.json({ok:true});
});

const users=new Map(); // online socket -> account
const channels=[
 {id:"general",name:"общий",type:"text"},{id:"games",name:"игры",type:"text"},
 {id:"memes",name:"мемы",type:"text"},{id:"lobby",name:"Лобби",type:"voice"},{id:"gaming",name:"Игры",type:"voice"}
];
const messages={general:[],games:[],memes:[]};
function online(){return [...users.entries()].map(([id,u])=>({id,...u}))}
function emitUsers(){io.emit("users",online())}

io.on("connection",socket=>{
 socket.on("auth",token=>{
   db.get(`SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=?`,[token],(e,row)=>{
     if(!row)return socket.emit("auth:error","Сессия недействительна");
     users.set(socket.id,{accountId:row.id,username:row.username,name:row.display_name,avatar:row.avatar||"",game:row.game||""});
     socket.emit("auth:ok",{user:safeUser(row)});emitUsers();
   });
 });
 socket.on("message",({channel,text})=>{
   const u=users.get(socket.id);if(!u||!messages[channel]||!String(text).trim())return;
   const m={name:u.name,username:u.username,avatar:u.avatar,text:String(text).slice(0,2000),time:new Date().toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"})};
   messages[channel].push(m);io.emit("channelMessage",{channel,message:m});
 });
 socket.on("channelMessages",c=>socket.emit("channelMessages",{channel:c,messages:messages[c]||[]}));
 socket.on("disconnect",()=>{users.delete(socket.id);emitUsers()});
});
io.on("connection",s=>s.emit("channels",channels));
server.listen(PORT,()=>console.log(`Wecsord running on port ${PORT}`));
