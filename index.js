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

    const page = await browser.newPage()
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36')
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 })

    // ── NOVO: espera ativa por um sinal DEFINITIVO ────────────────────────
    // Em vez de confiar cegamente num setTimeout fixo (que corre o risco de
    // capturar a página num estado intermediário — dados pré-renderizados mas
    // ainda não validados pela SEFAZ), espera até 8s por QUALQUER um dos dois
    // sinais: (a) o modal de erro da SEFAZ apareceu, ou (b) linhas de item
    // reais já estão no DOM. Não trava a requisição se nenhum dos dois
    // aparecer nesse tempo — só segue para o fallback de 3s que já existia.
    await page.waitForFunction(() => {
      const texto = document.body.innerText || ''
      const temErro = /assinatura do documento.*inconsistente|qr\s*code\s*inv[aá]lido|problemas na consulta/i.test(texto)
      const temItens = !!document.querySelector('tr[id^="Item"]')
      return temErro || temItens
    }, { timeout: 8000 }).catch(() => {})

    await new Promise(r => setTimeout(r, 1500))

    // ── NOVO: detecta o modal de erro da SEFAZ ANTES de extrair dados ─────
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
          // ── AUMENTADO NOVAMENTE: 16384 → 32768 ────────────────────────
          // 16384 ainda não foi suficiente para este cupom — a resposta
          // continuou sendo cortada no meio do JSON. gemini-2.5-flash-lite
          // suporta uma janela de saída bem maior, então subimos para 32768
          // como margem generosa. Se AINDA assim truncar, os logs abaixo
          // (finishReason + texto bruto) vão confirmar isso com certeza.
          maxOutputTokens: 32768,
          // ── NOVO: força modo de saída JSON estruturada ───────────────────
          // Resolve a segunda causa de erro ("Unterminated string in JSON"):
          // sem este modo, o Gemini gera o JSON como texto livre e pode
          // deixar de escapar corretamente aspas, quebras de linha ou outros
          // caracteres especiais dentro de valores de string (ex: nome de
          // produto com aspas ou acento incomum), quebrando a sintaxe. Com
          // responseMimeType: "application/json", a API usa decodificação
          // restrita para garantir que a saída seja sempre JSON sintaticamente
          // válido — elimina essa classe inteira de erro de parsing.
          responseMimeType: 'application/json'
        }
      }
    )

    const candidate = response.data?.candidates?.[0]

    // ── NOVO: detecta truncamento por limite de tokens ANTES do parse ─────
    // Se ainda assim a resposta for cortada (finishReason === 'MAX_TOKENS'),
    // dá pra saber exatamente o motivo em vez de um "Unexpected end of JSON
    // input" genérico — e também loga o texto bruto pra facilitar debug.
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
      // ── NOVO: loga o texto bruto que falhou no parse ───────────────────
      // Sem isso, só sabíamos que o parse falhou — não o que veio da IA.
      // Isso é essencial pra diagnosticar se foi truncamento, markdown
      // residual, ou a IA "alucinando" texto fora do JSON.
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