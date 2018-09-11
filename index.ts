import { mkdirSync, createWriteStream, readFile } from 'fs';
import { resolve, basename } from 'path';
import { Page } from 'puppeteer';
import * as puppeteer from 'puppeteer';
import * as request from 'request';
import * as yaml from 'js-yaml';
import * as prompt from 'prompt';

interface Emoji {
    name: string;
    src: string;
}

interface EmojiPack {
    title: string;
    emojis: Emoji[];
}

interface UserInput {
    host: string;
    email: string;
    password: string;
    show: boolean;
}

if (process.argv.length < 3) {
    console.log('usage: slack-emoji-import path/to/emoji-pack.yaml');
    process.exit(1);
}

const TEMP_DIR = resolve(__dirname, '.tmp');
const ENTRY_URL_FACTORY = host => `https://${host}.slack.com/?redir=%2Fcustomize%2Femoji`;
const YAML_PATH = resolve(process.cwd(), process.argv[2]);

try {
    mkdirSync(TEMP_DIR);
} catch (e) { }

start();

/**
 * 
 */
async function start(): Promise<void> {
    const userInput = await getUserInput();

    console.log('Launching browser...');
    const browser = await puppeteer.launch({ headless: !userInput.show, defaultViewport: { width: 1200, height: 1000 } });
    const browserCtx = await browser.createIncognitoBrowserContext();
    const page = await browserCtx.newPage();

    console.log('logging in...')
    await login(page, userInput);
    console.log('logged in.');

    const emojiPack = await loadEmojiPack(YAML_PATH);
    for (let emoji of emojiPack.emojis) {
        console.log(`downloading ${emoji.name}...`);
        const imagePath = await downloadImage(emoji.src);
        console.log(`downloaded  ${emoji.name}.`);

        console.log(`uploading ${emoji.name}...`);
        await upload(page, imagePath, emoji.name).then(sleep(10));
        console.log(`uploaded  ${emoji.name}.`);
    }
    console.log(' ');
    console.log(`Uploaded ${emojiPack.emojis} emojis.`);

    await browser.close();
}

/**
 * 
 */
function getUserInput(): Promise<UserInput> {
    return new Promise((promiseResolve, promiseReject) => {
        prompt.get([
            {
                description: 'Slack Host',
                name: 'host',
                required: true
            },
            {
                description: 'Slack login email',
                name: 'email',
                required: true
            },
            {
                description: 'Slack password',
                name: 'password',
                hidden: true,
                required: true
            },
            {
                description: 'Show browser',
                name: 'show',
                type: 'boolean',
                default: false,
                required: false
            },            
        ],
            (err, result) => err ? promiseReject(err) : promiseResolve(result),
        )
    });
}

/**
 * 
 */
async function login(page: Page, userInput: UserInput): Promise<void> {
    await page.goto(ENTRY_URL_FACTORY(userInput.host));

    const emailInputSelector = '#signin_form input[type=email]';
    await page.waitForSelector(emailInputSelector, { visible: true });
    setInputElementValue(page, emailInputSelector, userInput.email);

    setInputElementValue(page, '#signin_form input[type=password]', userInput.password);

    const signinButtonElement = await page.$('#signin_form #signin_btn');
    await signinButtonElement.click();

    await page.waitForSelector(emailInputSelector, { hidden: true });

}

/**
 * 
 */
function loadEmojiPack(path: string): Promise<EmojiPack> {
    return new Promise((promiseResolve, promiseReject) => {
        const yamlPath = resolve(__dirname, 'emoji', path);
        readFile(yamlPath, (error, yamlContent) => {
            if (error) {
                promiseReject(new Error('Unable to read emoji pack.'));
            }
            promiseResolve(yaml.load(yamlContent.toString()));
        });
    });
}

/**
 * 
 */
function downloadImage(url: string): Promise<string> {

    return new Promise((promiseResolve, promiseReject) => {

        if (!/^https?:\/\//.test(url)) {
            promiseReject(new Error(`Invalid url ${url}`));
        }

        const target = resolve(TEMP_DIR, basename(url));
        request(url).pipe(createWriteStream(target)).on('finish', () => promiseResolve(target));

    });

}

/**
 * 
 */
async function upload(page: Page, imagePath: string, name: string): Promise<void> {

    const addEmojiButtonElement = await page.waitForSelector('.p-customize_emoji_wrapper .c-button--primary', { visible: true });
    await addEmojiButtonElement.click();

    const fileInputElement = await page.waitForSelector('input#emojiimg');
    await fileInputElement.uploadFile(imagePath);

    const nameInputElement = await page.$('#emojiname');
    await nameInputElement.type(name);

    const saveEmojiButtonElement = await page.$('.c-dialog__footer .c-button--primary');
    await saveEmojiButtonElement.click();

    await page.waitForSelector('.c-dialog__footer .c-button--primary', { hidden: true });
}

/**
 * 
 */
async function setInputElementValue(page: Page, querySelector: string, value: string) {
    await page.waitForSelector(querySelector);
    return page.$$eval(querySelector, (element: HTMLInputElement[], v) => element[0].value = v, value);
}

/**
 * Adds delay to promise chain
 */
function sleep(time: number): () => Promise<void> {
    return () => new Promise(resolve => setTimeout(() => resolve(), time));
}