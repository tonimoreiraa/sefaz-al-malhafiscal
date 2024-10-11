import { createPuppeteerRouter } from 'crawlee';
import path from 'path'
import { Page } from 'puppeteer';
import fs from 'fs/promises'

export const router = createPuppeteerRouter();

router.addDefaultHandler(async ({ request, page, log, pushData }) => {
    const {
        name,
        login,
        password,
        years, meshTypes
    } = request.userData

    page.on('dialog', async (dialog) => {
        console.log('Alert detected:', dialog.message());
        await dialog.dismiss(); // Dismiss the alert
    })
    await page.goto('https://contribuinte.sefaz.al.gov.br/malhafiscal/#')
    const loginButton = await page.waitForSelector('a[jhitranslate="global.messages.info.authenticated.link"]')
    if (!loginButton) {
        throw new Error('Login button not found.')
    }
    await loginButton.click()

    await page.waitForSelector('#username')
    await page.type('#username', login)
    await page.type('#password', password)

    await page.click('#button-entrar')

    // Aguarda usuário logado
    const loginErrorSelector = 'div[jhitranslate="login.messages.error.authentication"]';
    const userLoggedSelector = '#span-usuario-logado';

    await Promise.race([
        page.waitForSelector(loginErrorSelector, { timeout: 10000 }),
        page.waitForSelector(userLoggedSelector, { timeout: 10000 })
    ]);

    if (await page.$(loginErrorSelector) !== null) {
        log.error(`${name} está com login inválido`)
        return
    } else if (await page.$(userLoggedSelector) !== null) {
        log.info(`Logado em ${name} com sucesso.`)
    }

    await page.goto('https://contribuinte.sefaz.al.gov.br/malhafiscal/#/pendencias')
    await page.waitForSelector('.black-overlay')
    await page.waitForSelector('.black-overlay', { hidden: true })

    await page.waitForSelector('#tipo')

    const companyData: any = {
        name,
        data: []
    }
    for (const year of years) {
        for (const meshType of meshTypes) {
            try {
                await page.select('#tipo', meshType)
                await page.select('#ano', year)
                await page.waitForSelector('.black-overlay').catch(_ => {})
                await page.waitForSelector('.black-overlay', { hidden: true }).catch(_ => {})
                await new Promise(r => setTimeout(r, 1000))

                const button = await page.$('jhi-notas-omissas form button[type="submit"]')

                if (!button) {
                    const pathToFile = path.join('./storage/downloads/Ok/', name, year, 'MFIC' + meshType)
                    await fs.mkdir(pathToFile, { recursive: true })
                    const screenshotPath = path.join(pathToFile, 'captura.png')
                    await page.screenshot({ path: screenshotPath, fullPage: true })
                    log.error(`${companyData.name}: ${year} - MFIC ${meshType} - Não há registros`)
                    continue
                }
                await button.click()

                await page.waitForSelector('.black-overlay')
                await page.waitForSelector('.black-overlay', { hidden: true })
                const tbody = await page.$$('jhi-notas-omissas table tbody tr')
                const thead = await page.$$eval('jhi-notas-omissas thead tr:nth-child(2) th', el => el.map(e => e.innerText))
                const rows = await Promise.all(tbody.map(row => row.$$eval('th', e => e.map(i => i.innerText))))
                const tableData = rows.map((row) => Object.fromEntries(row.map((value, index) => [thead[index], value])))
                
                companyData.data.push({
                    'Ano': year,
                    'Tipo de malha': 'MFIC' + meshType,
                    'Tabela': tableData,
                })
                log.info(`${companyData.name}: ${year} - MFIC ${meshType} - ${tableData.length} registros`)

                const pathToFile = path.join(`./storage/downloads${tableData.length == 0 ? '/Ok' : ''}`, name, year, 'MFIC' + meshType)
                await fs.mkdir(pathToFile, { recursive: true })
                const screenshotPath = path.join(pathToFile, 'captura.png')
                await page.screenshot({ path: screenshotPath, fullPage: true })

                for (const documentIndex in tableData) {
                    try {
                        const competencia = tableData[documentIndex].Competência.replace('/', '-')
                        log.info(`Baixando MFIC ${meshType} (${year}) - ${competencia}`)
                        await page.click(`jhi-notas-omissas table tbody tr:nth-child(${Number(documentIndex) + 1}) .btn.btn-pdf`)

                        const newTarget = await page.browserContext().waitForTarget(
                            target => target.url().startsWith('blob:')
                        );
                        const newPage = await newTarget.page() as Page;
                        await new Promise(async (resolve) => {
                            const blobUrl = newPage.url();
                            page.once('response', async (response) => {
                                const filePath = path.join(pathToFile, competencia + '.pdf')
                                const pdfBuffer = await response.buffer()
                                await fs.mkdir(pathToFile, { recursive: true }).catch()
                                await fs.writeFile(filePath, pdfBuffer)
                                resolve(undefined)
                            });
                            await page.evaluate((url) => { fetch(url); }, blobUrl);
                        })
                        await newPage.close()
                    } catch (e) {
                        console.error(e)
                    }
                }
            } catch (e) {
                console.error(e)
                await page.goto('https://contribuinte.sefaz.al.gov.br/malhafiscal/#/pendencias')
                await page.waitForSelector('.black-overlay')
                await page.waitForSelector('.black-overlay', { hidden: true })

                await page.waitForSelector('#tipo')
            }
        }
    }

    await pushData(companyData)
});