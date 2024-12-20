import { Actor, RequestQueue } from 'apify';
import { PuppeteerCrawler } from 'crawlee';
import { router } from './routes.js';

await Actor.init();

interface Input {
    companies: {
        name: string
        login: string
        password: string
    }[];
    meshTypes: string[]
    years: string[]
}
const { companies, meshTypes, years } = await Actor.getInput<Input>() ?? {};

const proxyConfiguration = await Actor.createProxyConfiguration();
const requestQueue = await RequestQueue.open()

for (const company of companies ?? []) {
    await requestQueue.addRequests([{
        url: 'https://contribuinte.sefaz.al.gov.br/malhafiscal/' + company.login,
        userData: { ...company, years, meshTypes },
    }]);
}

const crawler = new PuppeteerCrawler({
    maxConcurrency: 1,
    headless: false,
    requestQueue,
    proxyConfiguration,
    requestHandler: router,
    requestHandlerTimeoutSecs: 43200,
})

await crawler.run();

await Actor.exit();
