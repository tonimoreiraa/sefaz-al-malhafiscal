import { createPuppeteerRouter } from 'crawlee';
import path from 'path'
import { Page } from 'puppeteer';
import fs from 'fs/promises'
import { existsSync } from 'fs';

export const router = createPuppeteerRouter();

async function waitBlackOverlay(page: Page)
{
    await page.waitForSelector('.black-overlay').catch(_ => {})
    await page.waitForSelector('.black-overlay', { hidden: true, timeout: 60000 }).catch(_ => {})
}

router.addDefaultHandler(async ({ request, page, log, pushData }) => {
    const {
        name,
        login,
        password,
        meshTypes
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
    let txt = `# ${name}`

    for (const mesh of meshTypes) {
        await page.select('#tipo', mesh)

        await waitBlackOverlay(page)
        
        // Screenshot
        const pathToFile = path.join(`./storage/downloads`, name, )
        await fs.mkdir(pathToFile, { recursive: true })
        const screenshotPath = path.join(pathToFile, 'MFIC' + mesh + '.png')
        await page.screenshot({ path: screenshotPath, fullPage: true })

        await Promise.race([
            page.waitForSelector('span[jhitranslate="malha-sem-inconsistencia"]'),
            page.waitForSelector('.btn-group')
        ])
        const noInvoice = !!(await page.$('span[jhitranslate="malha-sem-inconsistencia"]'))

        if (noInvoice) {
            txt += `\nMFIC${mesh} - Nenhuma inconsistência. ✅`
            continue;    
        }

        const years = await page.$$('.btn-group .btn.btn-link')
        const yearsText = (await Promise.all(years.map(year => year.evaluate(el => el.textContent, year)))).map(r => r?.trim())

        txt += `\nMFIC${mesh} - ❌ Inconsistência nos anos: ` + yearsText.join(', ')

        let firstYear = true;
        for (const year of years) {
            const yearText = (await year.evaluate(el => el.textContent, year))?.trim() as string
            await year.click()
            const pathToFile = path.join(`./storage/downloads`, name, yearText, 'MFIC' + mesh)
            await fs.mkdir(pathToFile, { recursive: true })

            if (!firstYear) {
                await waitBlackOverlay(page)
            } else {
                firstYear = false;
            }

            await fs.mkdir(pathToFile, { recursive: true })
            const screenshotPath = path.join(pathToFile, `${yearText}.png`)
            await page.screenshot({ path: screenshotPath, fullPage: true })

            const isNotasOmissas = !!(await page.$('jhi-notas-omissas'))
            const tbody = await page.$$('jhi-main table tbody tr')
            const thead = await page.$$eval('jhi-main table thead tr:nth-child(2) th', el => el.map(e => e.innerText))
            const rows = await Promise.all(tbody.map(row => row.$$eval('th', e => e.map(i => i.innerText))))
            const tableData = rows.map((row) => Object.fromEntries(row.map((value, index) => [thead[index], value])))

            try {
                if (isNotasOmissas) {
                    for (const documentIndex in tableData) {
                        const competencia = tableData[documentIndex].Competência.replace('/', '-')
                        log.info(`Baixando MFIC ${mesh} (${yearText}) - ${competencia}`)
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
                    }
                } else if (tableData.length) {
                    const downloadButton = await page.waitForSelector('.text-center button.btn-primary')
                    if (downloadButton) {
                        await downloadButton.click()
                        const newTarget = await page.browserContext().waitForTarget(
                            target => target.url().startsWith('blob:')
                        );
                        const newPage = await newTarget.page() as Page;
                        await new Promise(async (resolve) => {
                            const blobUrl = newPage.url();
                            page.once('response', async (response) => {
                                const filePath = path.join(pathToFile, 'relatorio.pdf')
                                const pdfBuffer = await response.buffer()
                                await fs.mkdir(pathToFile, { recursive: true }).catch()
                                await fs.writeFile(filePath, pdfBuffer)
                                resolve(undefined)
                            });
                            await page.evaluate((url) => { fetch(url); }, blobUrl);
                        })
                        await newPage.close()
                    }
                }
            } catch (e) {
                console.error(e)
                txt += `\n  MFIC${mesh} ${yearText}: Falha ao baixar documento`
            } finally {
                txt += `\n  MFIC${mesh} ${yearText}: ${tableData.length} registros salvos`
            }   
        }
        const logPath = path.join('./storage/downloads/', name)
        await fs.mkdir(logPath, { recursive: true })
        await fs.writeFile(path.join(logPath, 'Relatório.txt'), txt)
    }
    txt += `\n\n###########################`
    

    await pushData(companyData)
});