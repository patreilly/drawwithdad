import { CreateTableCommand, DescribeTableCommand, DynamoDBClient, ResourceNotFoundException, UpdateTimeToLiveCommand } from "@aws-sdk/client-dynamodb";
import {
  BatchGetCommand,
  BatchWriteCommand,
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import type { Profile } from "../src/profiles/profile";
import type { Segment } from "../src/session/settings";
import type { ImageRef } from "../src/types";

/**
 * All server-side data, in one DynamoDB table (PK + SK, TTL on `ttl`).
 *
 *   EMAIL#<email>        EMAIL               login: accountId, passwordHash
 *   ACCT#<id>            ACCOUNT             email, createdAt, lastProfileId, sessionsValidAfter
 *   ACCT#<id>            PROFILE#<pid>       a profile (+ lockHash if it has a password)
 *   ACCT#<id>            FAV#<pid>#<image>   a saved picture (the image reference, never bytes)
 *   ACCT#<id>            HIST#<pid>#<ts>#<id> a finished drawing session
 *   ACCT#<id>            HIDDEN#<image>      hidden for the whole family
 *   ACCT#<id>            LIKE#<image>        this family gave the picture a thumbs up (one per family)
 *   LIKES#<image>        LIKES               how many families like the picture: count
 *   AUTH#<sha256>        AUTH                a login session (expires via TTL)
 *   RESET#<sha256>       RESET               a password-reset token (expires via TTL)
 *   RATE#<key>           RATE                a rate-limit counter (expires via TTL)
 *
 * Everything for one family lives under one partition key, so loading a
 * family is a single Query and deleting an account is exact.
 */

export interface AccountItem {
  accountId: string;
  email: string;
  createdAt: number;
  lastProfileId?: string;
  /** Sessions created before this (e.g. a password reset) are rejected. */
  sessionsValidAfter?: number;
}

export interface ProfileItem extends Omit<Profile, "hasLock"> {
  lockHash?: string;
}

export interface FavoriteItem {
  profileId: string;
  image: ImageRef;
  savedAt: number;
}

export interface HistoryItem {
  id: string;
  profileId: string;
  startedAt: number;
  endedAt?: number;
  prompt: string;
  categoryId?: string;
  segments: Segment[];
  imageIds: string[];
}

export interface HiddenItem {
  imageId: string;
  profileId: string;
  hiddenAt: number;
}

export interface AuthItem {
  accountId: string;
  createdAt: number;
  /** Password-protected profiles unlocked in this login session. */
  unlocked: string[];
}

export class EmailTakenError extends Error {}

const acct = (id: string) => `ACCT#${id}`;
const KEY_ATTRS = ["PK", "SK", "ttl"];

function strip<T>(item: Record<string, unknown> | undefined): T | undefined {
  if (!item) return undefined;
  const out = { ...item };
  for (const k of KEY_ATTRS) delete out[k];
  return out as T;
}

export interface RepoConfig {
  table: string;
  /** Set for DynamoDB Local (dev and Docker). Unset on AWS. */
  endpoint?: string;
  region?: string;
}

export class Repo {
  readonly doc: DynamoDBDocumentClient;
  private readonly raw: DynamoDBClient;

  constructor(private readonly config: RepoConfig) {
    this.raw = new DynamoDBClient({
      region: config.region ?? process.env.AWS_REGION ?? "us-east-1",
      ...(config.endpoint
        ? { endpoint: config.endpoint, credentials: { accessKeyId: "local", secretAccessKey: "local" } }
        : {}),
    });
    this.doc = DynamoDBDocumentClient.from(this.raw, { marshallOptions: { removeUndefinedValues: true } });
  }

  private get table() {
    return this.config.table;
  }

  /** Creates the table on DynamoDB Local. On AWS, CloudFormation owns the table. */
  async ensureTable(): Promise<void> {
    try {
      await this.raw.send(new DescribeTableCommand({ TableName: this.table }));
      return;
    } catch (e) {
      if (!(e instanceof ResourceNotFoundException)) throw e;
    }
    await this.raw.send(
      new CreateTableCommand({
        TableName: this.table,
        BillingMode: "PAY_PER_REQUEST",
        AttributeDefinitions: [
          { AttributeName: "PK", AttributeType: "S" },
          { AttributeName: "SK", AttributeType: "S" },
        ],
        KeySchema: [
          { AttributeName: "PK", KeyType: "HASH" },
          { AttributeName: "SK", KeyType: "RANGE" },
        ],
      }),
    );
    await this.raw.send(new UpdateTimeToLiveCommand({ TableName: this.table, TimeToLiveSpecification: { AttributeName: "ttl", Enabled: true } }));
  }

  // ---------- generic helpers ----------

  private async get<T>(PK: string, SK: string): Promise<T | undefined> {
    const r = await this.doc.send(new GetCommand({ TableName: this.table, Key: { PK, SK }, ConsistentRead: true }));
    // DynamoDB Local doesn't expire items, so check TTL ourselves too.
    if (r.Item && typeof r.Item.ttl === "number" && r.Item.ttl * 1000 < Date.now()) return undefined;
    return strip<T>(r.Item);
  }

  private async query<T>(PK: string, prefix: string, opts: { limit?: number; newestFirst?: boolean } = {}): Promise<T[]> {
    const out: T[] = [];
    let start: Record<string, unknown> | undefined;
    do {
      const r = await this.doc.send(
        new QueryCommand({
          TableName: this.table,
          KeyConditionExpression: "PK = :pk AND begins_with(SK, :prefix)",
          ExpressionAttributeValues: { ":pk": PK, ":prefix": prefix },
          ScanIndexForward: !opts.newestFirst,
          ExclusiveStartKey: start,
          ...(opts.limit ? { Limit: opts.limit - out.length } : {}),
        }),
      );
      for (const item of r.Items ?? []) out.push(strip<T>(item)!);
      start = r.LastEvaluatedKey;
    } while (start && (!opts.limit || out.length < opts.limit));
    return out;
  }

  private async deleteWhere(PK: string, prefix: string): Promise<void> {
    const keys: { PK: string; SK: string }[] = [];
    let start: Record<string, unknown> | undefined;
    do {
      const r = await this.doc.send(
        new QueryCommand({
          TableName: this.table,
          // DynamoDB rejects begins_with on an empty prefix, so "everything" is a plain PK match.
          KeyConditionExpression: prefix ? "PK = :pk AND begins_with(SK, :prefix)" : "PK = :pk",
          ExpressionAttributeValues: prefix ? { ":pk": PK, ":prefix": prefix } : { ":pk": PK },
          ProjectionExpression: "PK, SK",
          ExclusiveStartKey: start,
        }),
      );
      for (const item of r.Items ?? []) keys.push({ PK: item.PK, SK: item.SK });
      start = r.LastEvaluatedKey;
    } while (start);
    for (let i = 0; i < keys.length; i += 25) {
      let requests = keys.slice(i, i + 25).map((Key) => ({ DeleteRequest: { Key } }));
      // Retry anything DynamoDB couldn't process this round.
      for (let attempt = 0; requests.length && attempt < 5; attempt++) {
        const r = await this.doc.send(new BatchWriteCommand({ RequestItems: { [this.table]: requests } }));
        requests = (r.UnprocessedItems?.[this.table] ?? []) as typeof requests;
        if (requests.length) await new Promise((res) => setTimeout(res, 50 * 2 ** attempt));
      }
    }
  }

  // ---------- accounts ----------

  async createAccount(email: string, passwordHash: string, firstProfile: ProfileItem): Promise<AccountItem> {
    const account: AccountItem = { accountId: crypto.randomUUID(), email, createdAt: Date.now(), lastProfileId: firstProfile.id };
    try {
      await this.doc.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Put: {
                TableName: this.table,
                Item: { PK: `EMAIL#${email}`, SK: "EMAIL", accountId: account.accountId, passwordHash },
                ConditionExpression: "attribute_not_exists(PK)",
              },
            },
            { Put: { TableName: this.table, Item: { PK: acct(account.accountId), SK: "ACCOUNT", ...account } } },
            { Put: { TableName: this.table, Item: { PK: acct(account.accountId), SK: `PROFILE#${firstProfile.id}`, ...firstProfile } } },
          ],
        }),
      );
    } catch (e) {
      if ((e as Error).name === "TransactionCanceledException") throw new EmailTakenError();
      throw e;
    }
    return account;
  }

  getLogin(email: string) {
    return this.get<{ accountId: string; passwordHash: string }>(`EMAIL#${email}`, "EMAIL");
  }

  async setPassword(email: string, passwordHash: string, accountId: string): Promise<void> {
    await this.doc.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Update: {
              TableName: this.table,
              Key: { PK: `EMAIL#${email}`, SK: "EMAIL" },
              UpdateExpression: "SET passwordHash = :h",
              ConditionExpression: "accountId = :a",
              ExpressionAttributeValues: { ":h": passwordHash, ":a": accountId },
            },
          },
          {
            // Signs out every other device.
            Update: {
              TableName: this.table,
              Key: { PK: acct(accountId), SK: "ACCOUNT" },
              UpdateExpression: "SET sessionsValidAfter = :t",
              ExpressionAttributeValues: { ":t": Date.now() },
            },
          },
        ],
      }),
    );
  }

  getAccount(accountId: string) {
    return this.get<AccountItem>(acct(accountId), "ACCOUNT");
  }

  async setLastProfile(accountId: string, profileId: string): Promise<void> {
    await this.doc.send(
      new UpdateCommand({
        TableName: this.table,
        Key: { PK: acct(accountId), SK: "ACCOUNT" },
        UpdateExpression: "SET lastProfileId = :p",
        ExpressionAttributeValues: { ":p": profileId },
      }),
    );
  }

  /** Deletes the login and everything the family stored, and takes back its thumbs-ups. */
  async deleteAccount(account: AccountItem): Promise<void> {
    await this.doc.send(new DeleteCommand({ TableName: this.table, Key: { PK: `EMAIL#${account.email}`, SK: "EMAIL" } }));
    for (const like of await this.likedIds(account.accountId)) await this.unlike(account.accountId, like);
    await this.deleteWhere(acct(account.accountId), "");
  }

  // ---------- login sessions and tokens ----------

  async createAuth(tokenHash: string, item: AuthItem, ttlSeconds: number): Promise<void> {
    await this.doc.send(
      new PutCommand({ TableName: this.table, Item: { PK: `AUTH#${tokenHash}`, SK: "AUTH", ...item, ttl: Math.floor(Date.now() / 1000) + ttlSeconds } }),
    );
  }

  getAuth(tokenHash: string) {
    return this.get<AuthItem>(`AUTH#${tokenHash}`, "AUTH");
  }

  async setUnlocked(tokenHash: string, unlocked: string[]): Promise<void> {
    await this.doc.send(
      new UpdateCommand({
        TableName: this.table,
        Key: { PK: `AUTH#${tokenHash}`, SK: "AUTH" },
        UpdateExpression: "SET unlocked = :u",
        ConditionExpression: "attribute_exists(PK)",
        ExpressionAttributeValues: { ":u": unlocked },
      }),
    );
  }

  async deleteAuth(tokenHash: string): Promise<void> {
    await this.doc.send(new DeleteCommand({ TableName: this.table, Key: { PK: `AUTH#${tokenHash}`, SK: "AUTH" } }));
  }

  async createReset(tokenHash: string, accountId: string, email: string, ttlSeconds: number): Promise<void> {
    await this.doc.send(
      new PutCommand({
        TableName: this.table,
        Item: { PK: `RESET#${tokenHash}`, SK: "RESET", accountId, email, ttl: Math.floor(Date.now() / 1000) + ttlSeconds },
      }),
    );
  }

  /** Returns the token's account and deletes it, so each link works once. */
  async consumeReset(tokenHash: string): Promise<{ accountId: string; email: string } | undefined> {
    const r = await this.doc.send(
      new DeleteCommand({ TableName: this.table, Key: { PK: `RESET#${tokenHash}`, SK: "RESET" }, ReturnValues: "ALL_OLD" }),
    );
    const item = r.Attributes;
    if (!item || (typeof item.ttl === "number" && item.ttl * 1000 < Date.now())) return undefined;
    return { accountId: item.accountId, email: item.email };
  }

  /** Counts a hit against `key` and returns the count within the current window. */
  async hit(key: string, windowSeconds: number): Promise<number> {
    const now = Math.floor(Date.now() / 1000);
    const r = await this.doc.send(
      new UpdateCommand({
        TableName: this.table,
        Key: { PK: `RATE#${key}`, SK: "RATE" },
        // Start a fresh window when the old one has expired (DynamoDB Local never deletes it).
        UpdateExpression: "SET #c = if_not_exists(#c, :zero) + :one, #t = if_not_exists(#t, :ttl)",
        ConditionExpression: "attribute_not_exists(#t) OR #t > :now",
        ExpressionAttributeNames: { "#c": "count", "#t": "ttl" },
        ExpressionAttributeValues: { ":zero": 0, ":one": 1, ":ttl": now + windowSeconds, ":now": now },
        ReturnValues: "UPDATED_NEW",
      }),
    ).catch(async (e) => {
      if ((e as Error).name !== "ConditionalCheckFailedException") throw e;
      await this.doc.send(new PutCommand({ TableName: this.table, Item: { PK: `RATE#${key}`, SK: "RATE", count: 1, ttl: now + windowSeconds } }));
      return { Attributes: { count: 1 } };
    });
    return Number(r.Attributes?.count ?? 1);
  }

  // ---------- profiles ----------

  listProfiles(accountId: string) {
    return this.query<ProfileItem>(acct(accountId), "PROFILE#").then((p) => p.sort((a, b) => a.createdAt - b.createdAt));
  }

  getProfile(accountId: string, profileId: string) {
    return this.get<ProfileItem>(acct(accountId), `PROFILE#${profileId}`);
  }

  async putProfile(accountId: string, profile: ProfileItem): Promise<void> {
    await this.doc.send(new PutCommand({ TableName: this.table, Item: { PK: acct(accountId), SK: `PROFILE#${profile.id}`, ...profile } }));
  }

  async deleteProfile(accountId: string, profileId: string): Promise<void> {
    await this.deleteWhere(acct(accountId), `FAV#${profileId}#`);
    await this.deleteWhere(acct(accountId), `HIST#${profileId}#`);
    await this.doc.send(new DeleteCommand({ TableName: this.table, Key: { PK: acct(accountId), SK: `PROFILE#${profileId}` } }));
  }

  // ---------- saved pictures ----------

  async favorites(accountId: string, profileId: string): Promise<FavoriteItem[]> {
    const items = await this.query<FavoriteItem>(acct(accountId), `FAV#${profileId}#`);
    return items.sort((a, b) => b.savedAt - a.savedAt);
  }

  async addFavorite(accountId: string, item: FavoriteItem): Promise<void> {
    await this.doc.send(
      new PutCommand({ TableName: this.table, Item: { PK: acct(accountId), SK: `FAV#${item.profileId}#${item.image.id}`, ...item } }),
    );
  }

  async removeFavorite(accountId: string, profileId: string, imageId: string): Promise<void> {
    await this.doc.send(new DeleteCommand({ TableName: this.table, Key: { PK: acct(accountId), SK: `FAV#${profileId}#${imageId}` } }));
  }

  // ---------- history ----------

  history(accountId: string, profileId: string, limit: number) {
    return this.query<HistoryItem>(acct(accountId), `HIST#${profileId}#`, { limit, newestFirst: true });
  }

  async addHistory(accountId: string, item: HistoryItem): Promise<void> {
    const sk = `HIST#${item.profileId}#${String(item.startedAt).padStart(15, "0")}#${item.id}`;
    await this.doc.send(new PutCommand({ TableName: this.table, Item: { PK: acct(accountId), SK: sk, ...item } }));
  }

  clearHistory(accountId: string, profileId: string) {
    return this.deleteWhere(acct(accountId), `HIST#${profileId}#`);
  }

  // ---------- hidden images (family-wide) ----------

  hidden(accountId: string) {
    return this.query<HiddenItem>(acct(accountId), "HIDDEN#");
  }

  async hide(accountId: string, item: HiddenItem): Promise<void> {
    await this.doc.send(new PutCommand({ TableName: this.table, Item: { PK: acct(accountId), SK: `HIDDEN#${item.imageId}`, ...item } }));
  }

  async clearHidden(accountId: string, profileId: string): Promise<void> {
    const mine = (await this.hidden(accountId)).filter((h) => h.profileId === profileId);
    for (const h of mine) {
      await this.doc.send(new DeleteCommand({ TableName: this.table, Key: { PK: acct(accountId), SK: `HIDDEN#${h.imageId}` } }));
    }
  }

  // ---------- thumbs-ups (counts are public) ----------

  likedIds(accountId: string) {
    return this.query<{ imageId: string }>(acct(accountId), "LIKE#").then((items) => items.map((i) => i.imageId));
  }

  /** Likes the picture for this family. Returns false if the family already liked it. */
  async like(accountId: string, imageId: string): Promise<boolean> {
    return this.changeLike(accountId, imageId, 1);
  }

  /** Takes back this family's thumbs-up. Returns false if there wasn't one. */
  async unlike(accountId: string, imageId: string): Promise<boolean> {
    return this.changeLike(accountId, imageId, -1);
  }

  private async changeLike(accountId: string, imageId: string, delta: 1 | -1): Promise<boolean> {
    const mine = { PK: acct(accountId), SK: `LIKE#${imageId}` };
    try {
      await this.doc.send(
        new TransactWriteCommand({
          TransactItems: [
            delta > 0
              ? { Put: { TableName: this.table, Item: { ...mine, imageId, likedAt: Date.now() }, ConditionExpression: "attribute_not_exists(PK)" } }
              : { Delete: { TableName: this.table, Key: mine, ConditionExpression: "attribute_exists(PK)" } },
            {
              Update: {
                TableName: this.table,
                Key: { PK: `LIKES#${imageId}`, SK: "LIKES" },
                UpdateExpression: "SET #c = if_not_exists(#c, :zero) + :d",
                ExpressionAttributeNames: { "#c": "count" },
                ExpressionAttributeValues: { ":zero": 0, ":d": delta },
              },
            },
          ],
        }),
      );
      return true;
    } catch (e) {
      if ((e as Error).name === "TransactionCanceledException") return false;
      throw e;
    }
  }

  /** Thumbs-up counts for up to 100 pictures. Pictures nobody liked are left out. */
  async likeCounts(imageIds: string[]): Promise<Map<string, number>> {
    const counts = new Map<string, number>();
    let keys = [...new Set(imageIds)].slice(0, 100).map((id) => ({ PK: `LIKES#${id}`, SK: "LIKES" }));
    for (let attempt = 0; keys.length && attempt < 5; attempt++) {
      if (attempt) await new Promise((res) => setTimeout(res, 50 * 2 ** attempt));
      const r = await this.doc.send(new BatchGetCommand({ RequestItems: { [this.table]: { Keys: keys } } }));
      for (const item of r.Responses?.[this.table] ?? []) {
        if (item.count > 0) counts.set(String(item.PK).slice("LIKES#".length), Number(item.count));
      }
      keys = (r.UnprocessedKeys?.[this.table]?.Keys ?? []) as typeof keys;
    }
    return counts;
  }
}
