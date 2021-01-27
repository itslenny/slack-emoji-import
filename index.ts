import { mkdirSync, createWriteStream, readFile, readdir } from 'fs';
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
    console.log('usage: slack-emoji-import path/to/emoji-pack[.yaml]');
    process.exit(1);
}

const TYPING_DELAY = 20;
const TEMP_DIR = resolve(__dirname, '.tmp');
const ENTRY_URL_FACTORY = host => `https://${host}.slack.com/?redir=%2Fcustomize%2Femoji`;
const EMOJI_SOURCE_PATH = resolve(process.cwd(), process.argv[2]);

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

    const emojiPack = await loadEmojiPack(EMOJI_SOURCE_PATH);
    for (let emoji of emojiPack.emojis) {
        let imagePath: string;

        if (emoji.src.includes('://')) {
            console.log(`downloading ${emoji.name}...`);
            imagePath = await downloadImage(emoji.src);
            console.log(`downloaded  ${emoji.name}.`);
        } else {
            imagePath = emoji.src
            console.log(`using local file for ${emoji.name}.`);
        }

        console.log(`uploading ${emoji.name}...`);
        await upload(page, imagePath, emoji.name).then(sleep(100));
        console.log(`uploaded  ${emoji.name}.`);
    }
    console.log(' ');
    console.log(`Uploaded ${emojiPack.emojis.length} emojis.`);

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
    await page.waitForSelector(emailInputSelector, { visible: true }).then(sleep(500));
    
    await setInputElementValue(page, emailInputSelector, userInput.email);

    await setInputElementValue(page, '#signin_form input[type=password]', userInput.password);

    const signinButtonElement = await page.$('#signin_form #signin_btn');
    await signinButtonElement.click();

    await page.waitForSelector(emailInputSelector, { hidden: true });

}

/**
 * 
 */
function loadEmojiPack(path: string): Promise<EmojiPack> {
    return new Promise((promiseResolve, promiseReject) => {
        const emojiPath = resolve(__dirname, 'emoji', path);
        if (EMOJI_SOURCE_PATH.toLowerCase().endsWith('.yaml')) {
            readFile(emojiPath, (error, yamlContent) => {
                if (error) {
                    promiseReject(new Error('Unable to read emoji pack.'));
                    return;
                }
                promiseResolve(yaml.load(yamlContent.toString()));
            });
        } else {
            readdir(emojiPath, (error, files) => {
                if (error) {
                    promiseReject(new Error('Unable to read emoji directory.'));
                    return;
                }
                if (!files || files.length < 1) {
                    promiseReject(new Error('Directory does not contain any files.'));
                    return;
                }
                const emojis = files
                    .filter(file => !!file.match(/\.jpg|gif|png|jpeg$/i))
                    .map(file => {
                        const src = resolve(emojiPath, file);
                        const name = file.replace(/^(.*)\..*$/, '$1');
                        return { src, name };
                    });
                promiseResolve({
                    title: 'auto-generated',
                    emojis,
                });
            });
        }
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
    await page.evaluate(async () => {

        let addEmojiButtonSelector = ".p-customize_emoji_wrapper__custom_button";
        // Wait for emoji button to appear
        while (!document.querySelector(addEmojiButtonSelector)) {
            await new Promise(r => setTimeout(r, 500));
        }
        let buttonClassName = addEmojiButtonSelector.substring(1, addEmojiButtonSelector.length);
        const addEmojiButtonElement = <HTMLElement>document.getElementsByClassName(buttonClassName)[0];

        if (!addEmojiButtonElement)
            throw new Error('Add Emoji Button not found');

        addEmojiButtonElement.click();
    });

    const fileInputElement = await page.waitForSelector('input#emojiimg');
    await fileInputElement.uploadFile(imagePath);

    await setInputElementValue(page, '#emojiname', name);

    const saveEmojiButtonSelector = '.c-sk-modal_footer_actions .c-button--primary';
    const saveEmojiButtonElement = await page.waitForSelector(saveEmojiButtonSelector);
    await saveEmojiButtonElement.click();

    await page.waitForSelector(saveEmojiButtonSelector, { hidden: true });
}

/**
 * 
 */
async function setInputElementValue(page: Page, querySelector: string, value: string) {
    const element = await page.waitForSelector(querySelector);
    // clear existing value
    await page.focus(querySelector);
    await page.keyboard.press('Home');
    await page.keyboard.down('Shift');
    await page.keyboard.press('End');
    await page.keyboard.up('Shift');
    await page.keyboard.press('Backspace');
    // enter new value
    await element.type(value, { delay: TYPING_DELAY });
}

/**
 * Adds delay to promise chain
 */
function sleep(time: number): () => Promise<void> {
    return () => new Promise(resolve => setTimeout(() => resolve(), time));
}
