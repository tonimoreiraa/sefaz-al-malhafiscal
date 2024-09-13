import { createPuppeteerRouter } from 'crawlee';
import path from 'path'

export const router = createPuppeteerRouter();

router.addDefaultHandler(async ({ request, page, log, pushData }) => {
    const {
        name,
        login,
        password,
        years, meshTypes
    } = request.userData

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
                console.log(name, year, meshType)
                await page.select('#tipo', meshType)
                await page.select('#ano', year)
                await page.waitForSelector('.black-overlay')
                await page.waitForSelector('.black-overlay', { hidden: true })

                const button = await page.$('jhi-notas-omissas form button[type="submit"]')
                if (!button)
                    continue
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

                // for (const documentIndex in tableData) {
                //     const filePath = path.join(Actor.getEnv().defaultKeyValueStoreId, 'output.txt')
                // }
            } catch (e) {
                console.error(e)
            }
        }
    }

    await pushData(companyData)
});