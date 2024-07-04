const { 
  default: makeWASocket,
  MessageType,
  MessageOptions,
  Mimetype,
  DisconnectReason,
  BufferJSON,
  AnyMessageContent,
  delay,
  fetchLatestBaileysVersion,
  isJidBroadcast,
  makeCacheableSignalKeyStore,
  makeInMemoryStore,
  MessageRetryMap,
  useMultiFileAuthState,
  msgRetryCounterMap,
} = require("@whiskeysockets/baileys");
const { Boom } = require("@hapi/boom");
const log = require("pino")();
const express = require("express");
const fileUpload = require("express-fileupload");
const cors = require("cors");
const bodyParser = require("body-parser");
const http = require("http");
const socketIo = require("socket.io");
const qrcode = require("qrcode");
const path = require("path");
const fs = require("fs");

const app = express();
app.use(fileUpload({ createParentPath: true }));
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

const server = http.createServer(app);
const io = socketIo(server);
const port = process.env.PORT || 8000;

app.use("/assets", express.static(__dirname + "/client/assets"));
app.get("/scan", (req, res) => res.sendFile("./client/server.html", { root: __dirname }));
app.get("/", (req, res) => res.sendFile("./client/index.html", { root: __dirname }));

const store = makeInMemoryStore({ logger: log.child({ level: "silent", stream: "store" }) });

let sock;
let qr;
let soket;

async function connectToWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState("baileys_auth_info");
  const { version } = await fetchLatestBaileysVersion();
  
  sock = makeWASocket({
    printQRInTerminal: true,
    auth: state,
    logger: log,
    version,
  });

  store.bind(sock.ev);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect } = update;
    if (connection === "close") {
      const reason = new Boom(lastDisconnect?.error)?.output?.statusCode;
      switch (reason) {
        case DisconnectReason.badSession:
          console.log("Bad Session File, Please Delete session and Scan Again");
          sock.logout();
          break;
        case DisconnectReason.connectionClosed:
        case DisconnectReason.connectionLost:
        case DisconnectReason.timedOut:
          console.log("Connection closed, reconnecting...");
          setTimeout(connectToWhatsApp, 5000); // Adding a delay before reconnecting
          break;
        case DisconnectReason.connectionReplaced:
        case DisconnectReason.loggedOut:
          console.log("Device Logged Out, Please Delete session and Scan Again.");
          sock.logout();
          break;
        case DisconnectReason.restartRequired:
          console.log("Restart Required, Restarting...");
          setTimeout(connectToWhatsApp, 5000); // Adding a delay before reconnecting
          break;
        default:
          console.log(`Unknown DisconnectReason: ${reason}|${lastDisconnect.error}`);
          sock.logout();
      }
    } else if (connection === "open") {
      console.log("opened connection");
      // Fetch groups (optional)
      const groups = Object.values(await sock.groupFetchAllParticipating());
      groups.forEach(group => {
        console.log(`Group ID: ${group.id}, Group Name: ${group.subject}`);
      });
    }
    
    if (update.qr) {
      qr = update.qr;
      updateQR("qr");
    } else if (qr === undefined) {
      updateQR("loading");
    } else if (update.connection === "open") {
      updateQR("qrscanned");
    }
  });

  sock.ev.on("creds.update", saveCreds);
}

const isConnected = () => sock && sock.user;

const updateQR = (data) => {
  switch (data) {
    case "qr":
      qrcode.toDataURL(qr, (err, url) => {
        soket?.emit("qr", url);
        soket?.emit("log", "QR Code received, please scan!");
      });
      break;
    case "connected":
      soket?.emit("qrstatus", "./assets/check.svg");
      soket?.emit("log", "WhatsApp connected!");
      break;
    case "qrscanned":
      soket?.emit("qrstatus", "./assets/check.svg");
      soket?.emit("log", "QR Code scanned!");
      break;
    case "loading":
      soket?.emit("qrstatus", "./assets/loader.gif");
      soket?.emit("log", "Registering QR Code, please wait!");
      break;
    default:
      break;
  }
};

io.on("connection", (socket) => {
  soket = socket;
  if (isConnected()) {
    updateQR("connected");
  } else if (qr) {
    updateQR("qr");
  }
});

app.post("/send-message", async (req, res) => {
  const { message: pesankirim, number } = req.body;
  if (!number) {
    return res.status(400).json({ status: false, response: "Nomor WA belum disertakan!" });
  }

  const numberWA = "62" + number.substring(1) + "@s.whatsapp.net";
  try {
    if (isConnected()) {
      const exists = await sock.onWhatsApp(numberWA);
      if (exists?.jid || (exists && exists[0]?.jid)) {
        await sock.sendMessage(exists.jid || exists[0].jid, { text: pesankirim });
        return res.status(200).json({ status: true, response: "Message sent successfully" });
      } else {
        return res.status(400).json({ status: false, response: `Nomor ${number} tidak terdaftar.` });
      }
    } else {
      return res.status(500).json({ status: false, response: "WhatsApp belum terhubung." });
    }
  } catch (error) {
    return res.status(500).json({ status: false, response: error.message });
  }
});

// Untuk kirim pesan ke group by angga
app.post("/send-group-message", async (req, res) => {
  const { message: pesankirim, groupId } = req.body;
  if (!groupId) {
    return res.status(400).json({ status: false, response: "ID grup belum disertakan!" });
  }

  try {
    if (isConnected()) {
      await sock.sendMessage(groupId, { text: pesankirim });
      return res.status(200).json({ status: true, response: "Message sent successfully to the group" });
    } else {
      return res.status(500).json({ status: false, response: "WhatsApp belum terhubung." });
    }
  } catch (error) {
    return res.status(500).json({ status: false, response: error.message });
  }
});


connectToWhatsApp().catch(err => console.log("unexpected error: " + err));

server.listen(port, () => {
  console.log("Server running on port: " + port);
});
