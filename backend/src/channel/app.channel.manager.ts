import { retreiveDataBase } from "../app.database";
import { Logger, Inject } from "@nestjs/common";
import { User, UserManager } from "../user/app.user.manager";
import { NetsManager } from "src/app.nets.manager";
import { MessageManager } from "src/message/app.message.manager";

type UserType = {
    id: number;
    owner: boolean;
    admin: boolean;
    mute: number;
    ban: number;
}

class UserChannel {
    private id: number;
    private owner: boolean;
    private admin: boolean;
    private mute: number;
    private ban: number;
    private channel: Channel;
    banTimer: NodeJS.Timeout;
    muteTimer: NodeJS.Timeout;

    constructor(channel: Channel, id: number, owner: boolean, admin: boolean, mute: number, ban: number) {
        this.id = id;
        this.owner = owner; 
        this.admin = admin;
        this.channel = channel;
        this.mute = mute;
        this.ban = ban;
        this.channel = channel;
    }

    GetID() {
        return this.id;
    }

    IsAdmin() {
        return this.admin;
    }

    IsOwner() {
        return this.owner;
    }

    SetOwner(owner: boolean) {
        this.owner = owner;
    }

    SetAdmin(admin: boolean) {
        this.admin = admin;
    }

    SetMute(mute: boolean, time: number = 0) {
        if (mute) {
            if (time <= 0) {
                time = 60 * 24 * 365 * 100;
            }
            this.mute = (Date.now() / 1000) + time * 60;
        } else {
            this.mute = 0;
        }
    }

    IsMute() {
        return this.mute > (Date.now() / 1000);
    }

    GetMute() {
        return this.mute;
    }

    SetBan(ban: boolean, time: number = 0) {
        if (ban) {
            if (time <= 0) {
                time = 60 * 24 * 365 * 100;
            }
            this.ban = (Date.now() / 1000) + time * 60;
        } else {
            this.ban = 0;
        }
    }

    GetBan() {
        return this.ban;
    }

    IsBan() {
        return this.ban > (Date.now() / 1000);
    }
}

type ChannelType = {
    id: number;
    name: string;
    type: number;
    owner: number;
    users: string | {[key: number]: UserType};
    password: string;
    invite?: string;
}

const crypto = require('crypto');
const algorithm = 'aes-256-cbc';
const key = crypto.randomBytes(32);
const iv = crypto.randomBytes(16);

export function encrypt(text) {
   let cipher = crypto.createCipheriv(algorithm, Buffer.from(key), iv);
   let encrypted = cipher.update(text);
   encrypted = Buffer.concat([encrypted, cipher.final()]);
   return encrypted.toString('hex');
}

class Channel {
    private id: number;
    private name: string;
    private type: number;
    private owner: number;
    private users: {[key: number]: UserChannel} = {};
    private password: string;
    private channelManager: ChannelManager;
    private channelJSON: ChannelType;
    private invite: string;

    constructor(channelManager: ChannelManager, id: number, name: string, type: number, owner: number, users: {[id: number]: UserType}, password: string, invite: string) {
        this.id = id;
        this.name = name;
        this.type = type;
        this.owner = owner;
        this.password = password;
        this.channelManager = channelManager;
        this.invite = invite;

        this.channelJSON = {
            id: this.id,
            name: this.name,
            type: this.type,
            owner: this.owner,
            users: {},
            password: "hidden",
            invite: this.invite,
        }

        this.users = {};
        this.channelJSON.users = {};
        for (const key in users) {
            const value = users[key];
            this.users[key] = new UserChannel(this, value.id, value.owner, value.admin, value.mute, value.ban);
            this.channelJSON.users[key] = {
                id: value.id,
                owner: value.owner,
                admin: value.admin,
                mute: value.mute,
                ban: value.ban,
            }
        }
    }

    ExecUsers() {
        for (const [key, value] of Object.entries(this.users)) {
            if (value.IsBan()) {
                this.BanUser(value, true, (value.GetBan() - (Date.now() / 1000)) / 60);
            }
            if (value.IsMute()) {
                this.MuteUser(value, true, (value.GetMute() - (Date.now() / 1000)) / 60);
            }
        }
    }

    async AddUser(id: number, admin: boolean) {
        this.users[id] = new UserChannel(this, id, false, admin, 0, 0);
        await this.channelManager.UpdateChannel(this.id, "users", this.ParseUsers());
        this.SendNet("ContextChannel", {channel: this.id, id: id, index: "add", value: {
            id: id,
            owner: false,
            admin: admin,
            mute: 0,
            ban: 0,
        }});
        this.Log(`User ${id} added to channel ${this.id}`);
    }

    async RemoveUser(id: number) {
        const size = Object.keys(this.users).length;
        if (size <= 1) {
            await this.channelManager.RemoveChannel(this.id);
        } else {
            if (this.users[id].IsOwner()) {
                let newOwner: number | string = Object.keys(this.users)[0];
                if (newOwner === id.toString()) {
                    newOwner = Object.keys(this.users)[1];
                }
                newOwner = parseInt(newOwner);
                this.Log(`User ${newOwner} is new owner of channel ${this.id}`)
                this.users[newOwner].SetOwner(true);
                this.users[newOwner].SetAdmin(true);
                await this.channelManager.UpdateChannel(this.id, "owner", newOwner);
                this.SendNet("ContextChannel", {channel: this.id, id: newOwner, index: "owner", value: null});
            }
            this.SendNet("ContextChannel", {channel: this.id, id: id, index: "remove", value: null});

            delete this.users[id];
            await this.channelManager.UpdateChannel(this.id, "users", this.ParseUsers());
        }

        this.Log(`User ${id} removed from channel ${this.id}`);
    }

    GetUser(id: number) {
        return this.users[id];
    }

    HasUser(id: number) {
        return this.users[id] !== undefined;
    }

    ParseUsers() {
        const users = {} as {[id: number]: UserType};
        for (const [key, value] of Object.entries(this.users)) {
            users[key] = {
                id: value.GetID(),
                owner: value.IsOwner(),
                admin: value.IsAdmin(),
                mute: value.GetMute(),
                ban: value.GetBan(),
            }
        }
        return users;
    }

    Log(log: string) {
        this.channelManager.CLogger.log(log);
    }

    GetOwner() {
        return this.owner;
    }

    GetUsers() {
        return this.users;
    }

    GetID() {
        return this.id;
    }

    GetChannelJSON() {
        return this.channelJSON;
    }

    UpdateChannel(key: string, value: any) {
        if (key !== "users") {
            this[key] = value;
        }
        this.channelJSON[key] = value;
        this.Log(`Update channel ${this.id} with ${key} = ${value}`)
    }

    CanJoin(userID: number, password: string, invite?: string) {
        if (this.HasUser(userID)) {
            return false;
        } else if (this.type === 1) {
            return true;
        } else if (this.type === 2 && invite) {
            return this.invite === invite;
        } else if (this.type === 3 && this.password !== encrypt(password || "")) {
            return false;
        }
        return true;
    }

    async MuteUser(user: UserChannel, mute: boolean, time: number) {
        user.SetMute(mute, time);
        this.SendNet("ContextChannel", {channel: this.id, id: user.GetID(), index: "mute", value: user.GetMute()});
        if (user.muteTimer) {
            clearTimeout(user.muteTimer);
        }
        await this.channelManager.UpdateChannel(this.id, "users", this.ParseUsers());
        if (!mute) return;
        user.muteTimer = setTimeout(() => {
            if ((user.GetMute() * 1000) - Date.now() > 0) {
                this.MuteUser(user, true, (user.GetMute() - Date.now()) / 60000);
                return;
            }
            this.SendNet("ContextChannel", {channel: this.id, id: user.GetID(), index: "mute", value: 0});
        }, Math.min((user.GetMute() * 1000) - Date.now(), 2147483647));
    }

    async PromoteUser(user: UserChannel, promote: boolean) {
        user.SetAdmin(promote);
        this.SendNet("ContextChannel", {channel: this.id, id: user.GetID(), index: "admin", value: promote});
        await this.channelManager.UpdateChannel(this.id, "users", this.ParseUsers());
    }

    async BanUser(user: UserChannel, ban: boolean, time: number) {
        user.SetBan(ban, time);
        this.SendNet("ContextChannel", {channel: this.id, id: user.GetID(), index: "ban", value: user.GetBan()});
        if (user.banTimer) {
            clearTimeout(user.banTimer);
        }
        await this.channelManager.UpdateChannel(this.id, "users", this.ParseUsers());
        if (!ban) return;
        user.banTimer = setTimeout(() => {
            if ((user.GetBan() * 1000) - Date.now() > 0) {
                this.BanUser(user, true, (user.GetBan() - Date.now()) / 60000);
                return;
            }
            this.SendNet("ContextChannel", {channel: this.id, id: user.GetID(), index: "ban", value: 0});
        }, Math.min((user.GetBan() * 1000) - Date.now(), 2147483647));
    }

    SendNet(net: string, data: any) {
        this.channelManager.SendNet(this, net, data);
    }

    GetType() {
        return this.type;
    }

    Broadcast(net: string, data: any) {
        this.channelManager.Broadcast(net, data);
    }
}

class ChannelManager {
    private channels = {} as { [key: number]: Channel };
    private lastID = 0;
    private userManager: UserManager;
    private invite: {[id: string]: Channel} = {};

    public readonly CLogger = new Logger("ChannelManager");
    private netsManager: NetsManager;
    private messageManager: MessageManager;

    constructor() {
        retreiveChannels().then((channels: [ChannelType]) => {
            for (let channel of channels) {
                this.channels[channel.id] = new Channel(this, channel.id, channel.name, channel.type, channel.owner, JSON.parse(channel.users as string), channel.password, channel.invite);
                this.invite[channel.invite] = this.channels[channel.id];
                this.lastID = channel.id;
            }
            this.Log(`Initialize with ${channels.length} channels`);
        });
    }

    GenerateInvite() {
        let invite = "";
        const characters = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
        for (let i = 0; i < 10; i++) {
            invite += characters.charAt(Math.floor(Math.random() * characters.length));
        }
        if (this.invite[invite] !== undefined) {
            return this.GenerateInvite();
        }
        return invite;
    }

    async AddChannel(name: string, type: number, owner: number, password: string): Promise<Channel> {
        this.lastID++;
        const users = {
            [owner]: {
                id: owner,
                owner: true,
                admin: true,
                mute: 0,
                ban: 0,
            }
        } as {[id: number]: UserType};

        const invite = this.GenerateInvite();
        this.channels[this.lastID] = new Channel(this, this.lastID, name, type, owner, users, password, invite);
        this.invite[invite] = this.channels[this.lastID];
        
        const dataBase = await retreiveDataBase();
        await dataBase.query(`INSERT INTO "channels" ("id", "name", "type", "owner", "users", "password", "invite") VALUES ($1, $2, $3, $4, $5, $6, $7);`, [this.lastID, name, type, owner, JSON.stringify(users), password, invite]);
        this.Log(`Channel ${name} created (id: ${this.lastID}`);

        if (type === 4) {
            this.channels[this.lastID].SendNet("AddChannel", this.channels[this.lastID].GetChannelJSON());
        } else if (type !== 2) {
            this.Broadcast("AddChannel", this.channels[this.lastID].GetChannelJSON());
        }
        return this.channels[this.lastID]
    }
    
    async RemoveChannel(id: number) {
        if (!this.channels[id]) return;
        const dataBase = await retreiveDataBase();
        this.Log(`Channel ${id} deleted`);
        if (this.channels[id].GetType() !== 2) {
            this.Broadcast("RemoveChannel", id);
        }
        await this.messageManager.DeleteMessages(id)
        delete this.channels[id];
        await dataBase.query(`DELETE FROM "channels" WHERE "id" = $1;`, [id]);
    }

    async UpdateChannel(id: number, key: string, value: any) {
        this.channels[id].UpdateChannel(key, value);
        const dataBase = await retreiveDataBase();
        //this.Log(`Channel ${id} updated (${key})`);
        value = (typeof value === "object") ? JSON.stringify(value) : value;
        await dataBase.query(`UPDATE "channels" SET "${key}" = $1 WHERE "id" = $2;`, [value, id]);
    }

    GetChannelsUser(id: number) {
        const channels: {[id: number]: ChannelType} = {};
        for (const [key, value] of Object.entries(this.channels)) {
            if (value.HasUser(id) || value.GetType() === 1 || value.GetType() === 3) {
                channels[value.GetID()] = value.GetChannelJSON()
            }
        }
        return channels;
    }

    GetChannel(id: number): Channel {
        return this.channels[id];
    }

    GetChannels() {
        return this.channels;
    }

    GetChannelInvite(invite: string): Channel {
        return this.invite[invite];
    }

    Log(log: string) {
        this.CLogger.log(log);
    }

    SetUserManager(userManager: UserManager) {
        this.userManager = userManager;

        for (const [key, channel] of Object.entries(this.channels)) {
            channel.ExecUsers()
        }
    }

    SetMessageManager(messageManager: MessageManager) {
        this.messageManager = messageManager;
    }

    SetNetManager(netsManager: NetsManager) {
        this.netsManager = netsManager;
    }

    SendNet(channel: Channel, net: string, data: any) {
        for (const [key, value] of Object.entries(channel.GetUsers())) {
            const MUser = this.userManager.GetUser(value.GetID());
            if (!MUser) continue;
            MUser.SendNet(net, data);
        }
    }

    Broadcast(net: string, data: any) {
        this.netsManager.Broadcast(net, data);
    }
}

function retreiveChannels() {
    return new Promise<[ChannelType]>((resolve, reject) => {
        retreiveDataBase().then((dataBase) => {
            dataBase.query(`SELECT * FROM "channels";`).then((result) => {
                const channels = result.rows as [ChannelType];
                resolve(channels);
            }).catch((error) => {
                reject(error);
            });
        }).catch((error) => {
            reject(error);
        });
    });
}

export { ChannelManager, Channel, UserChannel };