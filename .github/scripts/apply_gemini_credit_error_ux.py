from pathlib import Path


def replace_once(text, old, new, label):
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{label}: expected 1 match, got {count}")
    return text.replace(old, new, 1)

server_path = Path('server.js')
server = server_path.read_text()
server = replace_once(
    server,
    "  } catch (error) {\n    console.error('[gemini-storyboard-error]', error);\n    return res.status(502).json({\n      available: false,\n      reason: 'GEMINI_STORYBOARD_ERROR',\n      message: 'Storyboard analizi sırasında hata oluştu.',\n      error: error?.message || String(error)\n    });\n  }\n});",
    "  } catch (error) {\n    console.error('[gemini-storyboard-error]', error);\n    const details = String(error?.message || error);\n    const creditsDepleted =\n      details.includes('prepayment credits are depleted') ||\n      (details.includes('RESOURCE_EXHAUSTED') && details.includes('429'));\n\n    if (creditsDepleted) {\n      return res.status(429).json({\n        available: false,\n        reason: 'GEMINI_CREDITS_DEPLETED',\n        message: 'Gemini API kredisi tükendi. Analiz başlatılamadı. AI Studio proje faturalandırmasını veya API anahtarını kontrol et.',\n        retryable: false,\n        error: details\n      });\n    }\n\n    return res.status(502).json({\n      available: false,\n      reason: 'GEMINI_STORYBOARD_ERROR',\n      message: 'Storyboard analizi sırasında hata oluştu.',\n      retryable: true,\n      error: details\n    });\n  }\n});",
    'server credit exhaustion response'
)
server_path.write_text(server)

app_path = Path('public/app.js')
app = app_path.read_text()
app = replace_once(
    app,
    "          if (!response.ok || !body?.available) {\n            failureBody = body || {\n              available: false,\n              reason: 'CHUNK_ANALYSIS_FAILED',\n              message: `Bölüm ${chunkIndex + 1} analiz edilemedi.`\n            };\n          } else {",
    "          if (!response.ok || !body?.available) {\n            failureBody = body || {\n              available: false,\n              reason: 'CHUNK_ANALYSIS_FAILED',\n              message: `Bölüm ${chunkIndex + 1} analiz edilemedi.`\n            };\n            if (failureBody?.retryable === false || failureBody?.reason === 'GEMINI_CREDITS_DEPLETED') {\n              break;\n            }\n          } else {",
    'first pass non retryable break'
)
app = replace_once(
    app,
    "              if (!reviewResponse.ok || !reviewBody?.available) {\n                failureBody = reviewBody || {\n                  available: false,\n                  reason: 'SECOND_PASS_REVIEW_FAILED',\n                  message: `Bölüm ${chunkIndex + 1} ikinci doğrulamadan geçemedi.`\n                };\n                continue;\n              }",
    "              if (!reviewResponse.ok || !reviewBody?.available) {\n                failureBody = reviewBody || {\n                  available: false,\n                  reason: 'SECOND_PASS_REVIEW_FAILED',\n                  message: `Bölüm ${chunkIndex + 1} ikinci doğrulamadan geçemedi.`\n                };\n                if (failureBody?.retryable === false || failureBody?.reason === 'GEMINI_CREDITS_DEPLETED') {\n                  break;\n                }\n                continue;\n              }",
    'second pass non retryable break'
)
app = replace_once(
    app,
    "        if (attempt < 3) {\n          await new Promise(resolve => setTimeout(resolve, attempt * 1800));\n        }",
    "        if (failureBody?.retryable === false || failureBody?.reason === 'GEMINI_CREDITS_DEPLETED') {\n          break;\n        }\n\n        if (attempt < 3) {\n          await new Promise(resolve => setTimeout(resolve, attempt * 1800));\n        }",
    'skip retry delay on terminal failure'
)
app = replace_once(
    app,
    "    if (!completeChunkAnalysis) {\n      body = {\n        available: false,\n        reason: 'INCOMPLETE_CHUNK_ANALYSIS',\n        message:\n          `Analiz eksik kaldı: ${chunkResults.length}/${chunkCount} bölüm tamamlandı. ` +\n          `Eksik video hiçbir zaman hazır oyun olarak açılmayacak.`,\n        completedChunkCount: chunkResults.length,\n        expectedChunkCount: chunkCount,\n        failedChunk: Math.min(chunkCount, chunkResults.length + 1),\n        failure: failureBody\n      };\n    } else {",
    "    if (!completeChunkAnalysis) {\n      if (failureBody?.reason === 'GEMINI_CREDITS_DEPLETED') {\n        body = {\n          ...failureBody,\n          available: false,\n          completedChunkCount: chunkResults.length,\n          expectedChunkCount: chunkCount,\n          failedChunk: Math.min(chunkCount, chunkResults.length + 1)\n        };\n      } else {\n        body = {\n          available: false,\n          reason: 'INCOMPLETE_CHUNK_ANALYSIS',\n          message:\n            `Analiz eksik kaldı: ${chunkResults.length}/${chunkCount} bölüm tamamlandı. ` +\n            `Eksik video hiçbir zaman hazır oyun olarak açılmayacak.`,\n          completedChunkCount: chunkResults.length,\n          expectedChunkCount: chunkCount,\n          failedChunk: Math.min(chunkCount, chunkResults.length + 1),\n          failure: failureBody\n        };\n      }\n    } else {",
    'preserve credit failure reason'
)
app = replace_once(
    app,
    "  if (!body?.available) {\n    els.analysisState.textContent = body?.reason || 'ANALYSIS_INCOMPLETE';\n    els.analysisTitle.textContent = 'Video analizi eksik kaldı';\n    els.analysisOutput.textContent = body?.message || 'Tüm video bölümleri doğrulanmadan oyun başlatılmadı.';\n    setGameState('ERROR');",
    "  if (!body?.available) {\n    const creditsDepleted = body?.reason === 'GEMINI_CREDITS_DEPLETED';\n    els.analysisState.textContent = body?.reason || 'ANALYSIS_INCOMPLETE';\n    els.analysisTitle.textContent = creditsDepleted\n      ? 'Gemini API kredisi tükendi'\n      : 'Video analizi eksik kaldı';\n    els.analysisOutput.textContent = creditsDepleted\n      ? [\n          'Gemini API kredisi tükendi. Analiz başlatılamadı.',\n          'Yeni kredi ekle veya geçerli bakiyesi olan başka bir Gemini API anahtarı kullan.',\n          'Bu hata için otomatik tekrar deneme yapılmadı.'\n        ].join('\\n')\n      : (body?.message || 'Tüm video bölümleri doğrulanmadan oyun başlatılmadı.');\n    setGameState('ERROR');",
    'user facing credit error'
)
app_path.write_text(app)
