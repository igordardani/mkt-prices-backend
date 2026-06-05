const express = require('express')
const cors = require('cors')
const puppeteer = require('puppeteer')

const app = express()
app.use(cors())
app.use(express.json())

app.get('/', (req, res) => {
  res.json({ status: 'mkt-prices backend rodando!' })
})

app.post('/parse-nfe', async (req, res) => {
  const { url } = req.body
  if (!url) return res.status(400).json({ error: 'URL não informada' })

  let browser
  try {
    browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    })

    const page = await browser.newPage()
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36')
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 })
    await new Promise(r => setTimeout(r, 3000))

    const dados = await page.evaluate(() => {
      const getText = (selector) => {
        const el = document.querySelector(selector)
        return el ? el.innerText.trim() : ''
      }
      const getAllText = (el, selector) => {
        const found = el.querySelector(selector)
        return found ? found.innerText.trim() : ''
      }

      // Mercado
      const mercado = getText('#u20') || getText('.txtTopo') || getText('#NomeEmit') || ''

      // CNPJ via regex
      const cnpjMatch = document.body.innerText.match(/\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}/)
      const cnpj = getText('#u21') || getText('#CNPJEmit') || (cnpjMatch ? cnpjMatch[0] : '')

      // Endereço — estratégia robusta para qualquer abreviatura de logradouro
      let endereco = getText('#u22') || getText('#EndEmit') || ''
      if (!endereco) {
        // Regex que aceita qualquer abreviatura comum de logradouro
        // Exige que após a abreviatura venha letra maiúscula (nome de rua real, não código)
        const enderecoRegex = /^(AVENIDA|AVENUE|AV\.?\s|RUA\s|R\.\s[A-Z]|ALAMEDA\s|TRAVESSA\s|ESTRADA\s|ROD\.\s|RODOVIA\s|PRAÇA\s|PC\.\s|LARGO\s|VIA\s|TV\.\s)/i

        const elementos = Array.from(document.querySelectorAll('div, span, td, p'))
        for (const el of elementos) {
          // Pega só o texto direto do elemento, sem filhos (evita blocos grandes)
          const txt = Array.from(el.childNodes)
            .filter(n => n.nodeType === 3)
            .map(n => n.textContent.trim())
            .join(' ')
            .trim() || el.innerText?.split('\n')[0]?.trim() || ''

          // Ignora textos muito longos, com código de produto, ou dados de item
          if (
            txt.length < 5 ||
            txt.length > 150 ||
            txt.includes('Código:') ||
            txt.includes('Qtde') ||
            txt.includes('Vl.') ||
            txt.includes('(Código') ||
            /^[A-Z]{2,}\d+/.test(txt) // começa com sigla+número (código de item)
          ) continue

          if (enderecoRegex.test(txt)) {
            endereco = txt.split('\n')[0].trim()
            break
          }
        }

        // Fallback: busca no texto completo da página com regex mais ampla
        if (!endereco) {
          const endMatch = document.body.innerText.match(
            /(AVENIDA|AV\.?\s+|RUA\s+|ALAMEDA\s+|TRAVESSA\s+|ESTRADA\s+|ROD\.\s+|RODOVIA\s+)[A-ZÁÉÍÓÚÀÂÊÎÔÛÃÕÇ][^\n,]{3,50}/i
          )
          if (endMatch) endereco = endMatch[0].trim()
        }
      }

      // Cidade e estado
      let cidade = getText('.Cidade') || ''
      let estado = getText('.UF') || ''
      if (!cidade || !estado) {
        const cidadeMatch = document.body.innerText.match(
          /,\s*([A-ZÀ-Ú][A-ZÀ-Ú\s]{2,})\s*[,\/]\s*(SP|RJ|MG|RS|PR|SC|BA|GO|DF|CE|PE|AM|PA)\b/i
        )
        if (cidadeMatch) {
          if (!cidade) cidade = cidadeMatch[1].trim()
          if (!estado) estado = cidadeMatch[2].trim()
        }
      }

      // Número da NF
      const numeroMatch = document.body.innerText.match(/N[uú]mero:\s*(\d+)/)
      const numero = getText('#u56') || getText('#nNF') || (numeroMatch ? numeroMatch[1] : '')

      // Chave de acesso (44 dígitos)
      const chaveMatch = document.body.innerText.replace(/\s/g, '').match(/\d{44}/)
      const chave_acesso = getText('#u44') || getText('#chNFe') || (chaveMatch ? chaveMatch[0] : '')

      // Data de emissão
      const emissaoMatch = document.body.innerText.match(/Emiss[aã]o:\s*(\d{2}\/\d{2}\/\d{4}\s+\d{2}:\d{2}:\d{2})/)
      const data_emissao = getText('#u48') || getText('#dhEmi') || (emissaoMatch ? emissaoMatch[1] : '')

      // Forma de pagamento
      const pagamentoMatch = document.body.innerText.match(/Cart[aã]o\s+de\s+D[eé]bito|Cart[aã]o\s+de\s+Cr[eé]dito|Dinheiro|PIX/i)
      const forma_pagamento = getText('#u57') || getText('#tPag') || (pagamentoMatch ? pagamentoMatch[0] : '')

      // Totais
      const valorPagarMatch = document.body.innerText.match(/Valor a pagar R\$[:\s]*([\d.]+,\d{2})/)
      const totalBrutoMatch = document.body.innerText.match(/Valor total R\$[:\s]*([\d.]+,\d{2})/)
      const descontoMatch = document.body.innerText.match(/Descontos R\$[:\s]*([\d.]+,\d{2})/)

      const total = valorPagarMatch
        ? parseFloat(valorPagarMatch[1].replace(/\./g, '').replace(',', '.'))
        : (() => {
            const totalEl = document.querySelector('#vNF') || document.querySelector('#u64') || document.querySelector('.totalNumb')
            return parseFloat((totalEl ? totalEl.innerText : '0').replace('R$', '').replace(/\./g, '').replace(',', '.').trim()) || 0
          })()

      const total_bruto = totalBrutoMatch
        ? parseFloat(totalBrutoMatch[1].replace(/\./g, '').replace(',', '.'))
        : 0

      const desconto = descontoMatch
        ? parseFloat(descontoMatch[1].replace(/\./g, '').replace(',', '.'))
        : 0

      // Itens
      const itens = []
      const linhas = document.querySelectorAll('tr[id^="Item"]')

      linhas.forEach(tr => {
        const nome = getAllText(tr, '.txtTit') || ''
        const codigoRaw = getAllText(tr, '.RCod') || ''
        const codigo = codigoRaw.replace('(Código:', '').replace(')', '').trim()

        const qtdRaw = getAllText(tr, '.Rqtd') || '0'
        const quantidade = parseFloat(qtdRaw.replace('Qtde.:', '').replace(',', '.').trim()) || 0

        // Normaliza unidade — remove sufixos numéricos (KG9 → KG, UND9 → UN, etc)
        const unRaw = getAllText(tr, '.RUN') || ''
        const unidadeRaw = unRaw.replace('UN:', '').trim()
        const unidade = unidadeRaw
          .replace(/^(KG)\d+$/i, 'KG')
          .replace(/^(UN|UND|UNI)\d*$/i, 'UN')
          .replace(/^(BDJ)\d*$/i, 'BDJ')
          .replace(/^(TBO)\d*$/i, 'TBO')
          || unidadeRaw

        const unitRaw = getAllText(tr, '.RvlUnit') || '0'
        const preco_unitario = parseFloat(unitRaw.replace('Vl. Unit.:', '').replace(',', '.').trim()) || 0

        const totalRaw = getAllText(tr, '.valor') || getAllText(tr, '.RvlTotal') || '0'
        const preco_total = parseFloat(totalRaw.replace('Vl. Total', '').replace('R$', '').replace(',', '.').trim()) || 0

        if (nome) itens.push({ nome, codigo, quantidade, unidade, preco_unitario, preco_total })
      })

      return { mercado, cnpj, endereco, cidade, estado, numero, chave_acesso, data_emissao, total, total_bruto, desconto, forma_pagamento, itens }
    })

    console.log('Dados extraídos:', JSON.stringify(dados, null, 2))
    res.json(dados)

  } catch (error) {
    console.error('Erro:', error.message)
    res.status(500).json({ error: 'Erro ao buscar nota fiscal', detalhes: error.message })
  } finally {
    if (browser) await browser.close()
  }
})

const PORT = process.env.PORT || 3000
app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`)
})