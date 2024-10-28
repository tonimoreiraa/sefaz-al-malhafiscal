import { createPuppeteerRouter } from 'crawlee';
import path from 'path'
import { Page } from 'puppeteer';
import fs from 'fs/promises'
import { existsSync } from 'fs';

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
    let txt = `# ${name}\n\n`
    const maxRetries = 3;

    for (const [year, meshType] of years.flatMap((year: string) => meshTypes.map((meshType: string) => [year, meshType]))) {
        let success = false;
        let attempts = 0;

        while (!success && attempts < maxRetries) {
            try {
                console.log(`Baixando ${name} - ${year} - MFIC ${meshType}`)
                if (existsSync(path.join('./storage/downloads/', name, 'MFIC' + meshType, year, 'captura.png'))) {
                    success = true;
                    continue;
                }
                const logPath = path.join('./storage/downloads/', name)
                await fs.mkdir(logPath, { recursive: true })
                await fs.writeFile(path.join(logPath, 'Relatório.txt'), txt)
                await page.select('#tipo', meshType)
                await page.select('#ano', year)
                await page.waitForSelector('.black-overlay').catch(_ => {})
                await page.waitForSelector('.black-overlay', { hidden: true }).catch(_ => {})
                await new Promise(r => setTimeout(r, 1000))

                const button = await page.$('jhi-notas-omissas form button[type="submit"]')

                if (button) {
                    await button.click()
                    await page.waitForSelector('.black-overlay')
                    await page.waitForSelector('.black-overlay', { hidden: true })
                }

                const tbody = await page.$$('jhi-main table tbody tr')
                const thead = await page.$$eval('jhi-main table thead tr:nth-child(2) th', el => el.map(e => e.innerText))
                const rows = await Promise.all(tbody.map(row => row.$$eval('th', e => e.map(i => i.innerText))))
                const tableData = rows.map((row) => Object.fromEntries(row.map((value, index) => [thead[index], value])))
                
                companyData.data.push({
                    'Ano': year,
                    'Tipo de malha': 'MFIC' + meshType,
                    'Tabela': tableData,
                })
                log.info(`${companyData.name}: ${year} - MFIC ${meshType} - ${tableData.length} registros`)

                const isNotasOmissas = !!(await page.$('jhi-notas-omissas'))
                const pathToFile = path.join(`./storage/downloads`, name, 'MFIC' + meshType, year)
                await fs.mkdir(pathToFile, { recursive: true })
                const screenshotPath = path.join(pathToFile, 'captura.png')
                await page.screenshot({ path: screenshotPath, fullPage: true })
                txt += `## ${year} - MFIC ${meshType}\n${tableData.length == 0 ? 'Não há registros' : `${tableData.length} registros encontrados.`}\n\n`

                try {
                    if (isNotasOmissas) {
                        for (const documentIndex in tableData) {
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
                    console.log('Erro ao baixar documento')
                }
                success = true;
            } catch (error) {
                attempts++;
                await page.goto('https://contribuinte.sefaz.al.gov.br/malhafiscal/#/pendencias')
                await page.waitForSelector('.black-overlay')
                await page.waitForSelector('.black-overlay', { hidden: true })
                await page.waitForSelector('#tipo')
                console.error(`Attempt ${attempts} failed for year ${year} and meshType ${meshType}:`, error);

                if (attempts >= maxRetries) {
                    console.error(`Max retries reached for year ${year} and meshType ${meshType}`);
                }
            }
        }
    }

    await pushData(companyData)
});