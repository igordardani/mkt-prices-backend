const express = require('express')
const cors = require('cors')
const puppeteer = require('puppeteer')

const app = express()
app.use(cors())
app.use(express.json({ limit: "20mb" }))

app.get('/', (req, res) => {
  res.json({ status: 'mkt-prices backend rodando!' })
})

app.post('/parse-nfe', async (req, res) => {
  const { url } = req.body
  if (!url) return res.status(400).json({ error: 'URL não informada' })

  let browser
  try {
    // ── DIAGNÓSTICO TEMPORÁRIO ──────────────────────────────────────────
    // Teste de conectividade "crua" (sem Puppeteer) ANTES de abrir o
    // navegador. Se isso também travar/der timeout, o problema é a SEFAZ
    // bloqueando o IP do Render (ou rede indisponível) — não o Puppeteer.
    // Se isso funcionar mas o Puppeteer travar depois, o problema é o
    // Chrome (provavelmente --single-process crashando com pouca RAM).
    try {
      const axios = require('axios')
      const t0 = Date.now()
      await axios.get(url, {
        timeout: 15000,
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
      })
      console.log(`[DIAG] axios conseguiu acessar a URL em ${Date.now() - t0}ms`)
    } catch (diagErr) {
      console.log(`[DIAG] axios FALHOU ao acessar a URL: ${diagErr.code || diagErr.message}`)
    }

    console.log('[DIAG] iniciando puppeteer.launch...')
    const tLaunch = Date.now()
    // ── AJUSTE PARA RENDER FREE TIER (512MB RAM) ──────────────────────────
    browser = await puppeteer.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--single-process',
        '--no-zygote',
      ]
    })
    console.log(`[DIAG] puppeteer.launch concluído em ${Date.now() - tLaunch}ms`)

    const page = await browser.newPage()
    console.log('[DIAG] newPage() concluído, indo para page.goto...')
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36')

    // ── FIX: troca de 'networkidle2' → 'domcontentloaded' ─────────────────
    // 'networkidle2' exige a rede "quieta" (≤2 conexões abertas) por 500ms
    // seguidos — condição frágil nesse portal (qualquer polling/analytics em
    // segundo plano nunca deixa a rede "descansar", estourando os 30s mesmo
    // com o conteúdo relevante já carregado). 'domcontentloaded' dispara
    // assim que o HTML inicial está pronto, e o waitForFunction logo abaixo
    // já cobre a espera ativa pelo conteúdo dinâmico de verdade (erro da
    // SEFAZ ou linhas de item no DOM) — muito mais robusto que depender de
    // "rede parada" num ambiente com CPU limitada (Render free tier +
    // --single-process --no-zygote).
    const tGoto = Date.now()
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 })
    console.log(`[DIAG] page.goto concluído em ${Date.now() - tGoto}ms`)

    // ── Espera ativa por um sinal DEFINITIVO ───────────────────────────────
    // Em vez de confiar cegamente num setTimeout fixo (que corre o risco de
    // capturar a página num estado intermediário — dados pré-renderizados mas
    // ainda não validados pela SEFAZ), espera até 20s por QUALQUER um dos dois
    // sinais: (a) o modal de erro da SEFAZ apareceu, ou (b) linhas de item
    // reais já estão no DOM. Aumentado de 8s → 20s: o log de diagnóstico
    // mostrou que o goto termina rápido (domcontentloaded), mas o conteúdo
    // real (renderizado via JS no cliente) ainda não tinha aparecido nem
    // após 8s+1.5s — resultando em extração inteiramente vazia.
    const sinalEncontrado = await page.waitForFunction(() => {
      const texto = document.body.innerText || ''
      const temErro = /assinatura do documento.*inconsistente|qr\s*code\s*inv[aá]lido|problemas na consulta/i.test(texto)
      const temItens = !!document.querySelector('tr[id^="Item"]')
      return temErro || temItens
    }, { timeout: 20000 }).then(() => true).catch(() => false)

    console.log(`[DIAG] sinal definitivo encontrado: ${sinalEncontrado}`)

    await new Promise(r => setTimeout(r, 1500))

    // ── DIAGNÓSTICO: mostra o que a página realmente tinha no momento
    // da extração, pra confirmar se o conteúdo chegou a carregar ─────────
    const diagTexto = await page.evaluate(() => (document.body.innerText || '').slice(0, 500))
    console.log(`[DIAG] tamanho do texto da página: ${diagTexto.length > 0 ? 'ver abaixo' : '0 (vazia)'}`)
    console.log(`[DIAG] primeiros 500 chars da página:\n${diagTexto}`)

    // ── Detecta o modal de erro da SEFAZ ANTES de extrair dados ───────────
    // Se a própria SEFAZ está dizendo que o QR é inválido/assinatura não
    // confere, não tenta "adivinhar" nada via regex — recusa direto.
    const erroSefaz = await page.evaluate(() => {
      const texto = document.body.innerText || ''
      return /assinatura do documento.*inconsistente|qr\s*code\s*inv[aá]lido|problemas na consulta/i.test(texto)
    })

    if (erroSefaz) {
      return res.status(422).json({
        error: 'A SEFAZ rejeitou este QR Code (erro de assinatura/digest inconsistente).',
        sefaz_erro: true,
      })
    }

    const dados = await page.evaluate(() => {
      const getText = (selector) => {
        const el = document.querySelector(selector)
        return el ? el.innerText.trim() : ''
      }
      const getAllText = (el, selector) => {
        const found = el.querySelector(selector)
        return found ? found.innerText.trim() : ''
      }

      const mercado = getText('#u20') || getText('.txtTopo') || getText('#NomeEmit') || ''

      const cnpjMatch = document.body.innerText.match(/\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}/)
      const cnpj = getText('#u21') || getText('#CNPJEmit') || (cnpjMatch ? cnpjMatch[0] : '')

      let endereco = getText('#u22') || getText('#EndEmit') || ''
      if (!endereco) {
        const enderecoRegex = /^(AVENIDA|AVENUE|AV\.?\s|RUA\s|R\.\s[A-Z]|ALAMEDA\s|TRAVESSA\s|ESTRADA\s|ROD\.\s|RODOVIA\s|PRAÇA\s|PC\.\s|LARGO\s|VIA\s|TV\.\s)/i

        const elementos = Array.from(document.querySelectorAll('div, span, td, p'))
        for (const el of elementos) {
          const txt = Array.from(el.childNodes)
            .filter(n => n.nodeType === 3)
            .map(n => n.textContent.trim())
            .join(' ')
            .trim() || el.innerText?.split('\n')[0]?.trim() || ''

          if (
            txt.length < 5 ||
            txt.length > 150 ||
            txt.includes('Código:') ||
            txt.includes('Qtde') ||
            txt.includes('Vl.') ||
            txt.includes('(Código') ||
            /^[A-Z]{2,}\d+/.test(txt)
          ) continue

          if (enderecoRegex.test(txt)) {
            endereco = txt.split('\n')[0].trim()
            break
          }
        }

        if (!endereco) {
          const endMatch = document.body.innerText.match(
            /(AVENIDA|AV\.?\s+|RUA\s+|ALAMEDA\s+|TRAVESSA\s+|ESTRADA\s+|ROD\.\s+|RODOVIA\s+)[A-ZÁÉÍÓÚÀÂÊÎÔÛÃÕÇ][^\n,]{3,50}/i
          )
          if (endMatch) endereco = endMatch[0].trim()
        }
      }

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

      const numeroMatch = document.body.innerText.match(/N[uú]mero:\s*(\d+)/)
      const numero = getText('#u56') || getText('#nNF') || (numeroMatch ? numeroMatch[1] : '')

      const chaveMatch = document.body.innerText.replace(/\s/g, '').match(/\d{44}/)
      const chave_acesso = getText('#u44') || getText('#chNFe') || (chaveMatch ? chaveMatch[0] : '')

      const emissaoMatch = document.body.innerText.match(/Emiss[aã]o:\s*(\d{2}\/\d{2}\/\d{4}\s+\d{2}:\d{2}:\d{2})/)
      const data_emissao = getText('#u48') || getText('#dhEmi') || (emissaoMatch ? emissaoMatch[1] : '')

      const pagamentoMatch = document.body.innerText.match(/Cart[aã]o\s+de\s+D[eé]bito|Cart[aã]o\s+de\s+Cr[eé]dito|Dinheiro|PIX/i)
      const forma_pagamento = getText('#u57') || getText('#tPag') || (pagamentoMatch ? pagamentoMatch[0] : '')

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

      const itens = []
      const linhas = document.querySelectorAll('tr[id^="Item"]')

      linhas.forEach(tr => {
        const nome = getAllText(tr, '.txtTit') || ''
        const codigoRaw = getAllText(tr, '.RCod') || ''
        const codigo = codigoRaw.replace('(Código:', '').replace(')', '').trim()

        const qtdRaw = getAllText(tr, '.Rqtd') || '0'
        const quantidade = parseFloat(qtdRaw.replace('Qtde.:', '').replace(',', '.').trim()) || 0

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

app.post('/parse-nfe-pdf', async (req, res) => {
  const { pdf_base64 } = req.body
  if (!pdf_base64) return res.status(400).json({ error: 'PDF não informado' })

  try {
    const axios = require('axios')

    const prompt = `Você é um extrator de dados de cupom fiscal eletrônico brasileiro (NF-e/NFC-e).
Analise este PDF de cupom fiscal e extraia os dados no formato JSON abaixo.
Responda SOMENTE com o JSON, sem texto adicional, sem markdown, sem explicações.

Formato esperado:
{
  "mercado": "nome do estabelecimento",
  "cnpj": "00.000.000/0000-00",
  "endereco": "endereço completo",
  "cidade": "nome da cidade",
  "estado": "UF",
  "numero": "número da NF",
  "chave_acesso": "44 dígitos sem espaços",
  "data_emissao": "DD/MM/YYYY HH:MM:SS",
  "forma_pagamento": "forma de pagamento",
  "total": 0.00,
  "total_bruto": 0.00,
  "desconto": 0.00,
  "itens": [
    {
      "nome": "nome do produto",
      "codigo": "código do produto",
      "quantidade": 0.000,
      "unidade": "UN ou KG etc",
      "preco_unitario": 0.00,
      "preco_total": 0.00
    }
  ]
}

Regras:
- chave_acesso: remova todos os espaços, deve ter exatamente 44 dígitos
- total: use o campo "Valor a pagar" se existir, senão "Valor total"
- total_bruto: use o campo "Valor total R$" (antes do desconto)
- desconto: use o campo "Descontos R$", se não houver use 0
- data_emissao: formato DD/MM/YYYY HH:MM:SS
- preco_unitario: valor unitário de cada item
- quantidade: número com ponto como separador decimal
- Se um campo não existir no cupom, use null para strings e 0 para números`

    const apiKey = process.env.GEMINI_API_KEY
    const response = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${apiKey}`,
      {
        contents: [
          {
            parts: [
              { inline_data: { mime_type: 'application/pdf', data: pdf_base64 } },
              { text: prompt }
            ]
          }
        ],
        generationConfig: {
          temperature: 0,
          maxOutputTokens: 32768,
          responseMimeType: 'application/json'
        }
      }
    )

    const candidate = response.data?.candidates?.[0]

    if (candidate?.finishReason === 'MAX_TOKENS') {
      console.error('Gemini cortou a resposta por limite de tokens (MAX_TOKENS).')
      return res.status(500).json({
        error: 'Erro ao processar o PDF',
        detalhes: 'A resposta da IA foi cortada por exceder o limite de tokens (cupom com muitos itens). Tente novamente — se persistir, o limite precisa ser aumentado ainda mais.'
      })
    }

    const rawText = (candidate?.content?.parts || [])
      .map(p => p.text || '')
      .join('')
      .replace(/```json|```/g, '')
      .trim()

    if (!rawText) {
      console.error('Resposta do Gemini veio vazia. finishReason:', candidate?.finishReason, 'response completo:', JSON.stringify(response.data))
      return res.status(500).json({
        error: 'Erro ao processar o PDF',
        detalhes: `A IA não retornou conteúdo (finishReason: ${candidate?.finishReason || 'desconhecido'}). O PDF pode estar ilegível ou ter sido bloqueado por filtro de segurança.`
      })
    }

    let dados
    try {
      dados = JSON.parse(rawText)
    } catch (parseError) {
      console.error('Falha ao fazer parse do JSON retornado pelo Gemini.')
      console.error('finishReason:', candidate?.finishReason)
      console.error('Texto bruto recebido (primeiros 2000 chars):', rawText.slice(0, 2000))
      console.error('Texto bruto recebido (últimos 500 chars):', rawText.slice(-500))
      return res.status(500).json({
        error: 'Erro ao processar o PDF',
        detalhes: `A IA retornou um JSON inválido/incompleto (${parseError.message}). Verifique os logs do servidor para o texto bruto.`
      })
    }

    if (dados.chave_acesso) {
      dados.chave_acesso = dados.chave_acesso.replace(/\s/g, '')
    }

    console.log('Dados extraídos do PDF:', JSON.stringify(dados, null, 2))
    res.json(dados)

  } catch (error) {
    console.error('Erro ao processar PDF:', error?.response?.data || error.message)
    res.status(500).json({
      error: 'Erro ao processar o PDF',
      detalhes: error?.response?.data?.error?.message || error.message
    })
  }
})

const PORT = process.env.PORT || 3000
app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`)
})