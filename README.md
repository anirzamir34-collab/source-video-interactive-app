# Source Video Interactive App

Bu proje, Google AI Studio'dan bağımsız çalışan mobil-first interaktif video istemcisidir.

## Bu sürümün amacı

- Render'daki gerçek harici analiz servisine server-side bağlanır.
- `/health` ve `/capabilities` durumunu gerçek cevaplardan gösterir.
- Video seçme ve `/analyze` isteğini server-side proxy üzerinden gönderir.
- Harici servis gerçek, doğrulanmış `actions[]` dönmedikçe seçim üretmez.
- Eski Gemini/local fallback yoktur.
- Her choice kendi `startTime -> endTime` segmentini oynatır ve segment sonunda video durur.
- `gameCursorTime`, `currentActionIndex` ve `consumedActionIds` ile zaman çizelgesi geriye dönmez.

## Mevcut durum

Harici servisiniz:

`https://source-video-analysis.onrender.com`

şu anda `/health` ve `/capabilities` sunuyor; gerçek `/analyze` inference henüz kurulu olmadığı için 501 döndürmesi beklenir. Bu web uygulaması bu hatayı açıkça gösterir ve sahte action üretmez.

## Render deploy

Yeni bir GitHub reposu oluşturun:

`source-video-interactive-app`

Bu klasörü repoya push edin. Render'da:

- New Web Service
- Repo: `source-video-interactive-app`
- Runtime: Node
- Build Command: `npm install`
- Start Command: `npm start`
- Free plan

Environment Variable isteğe bağlıdır:

`EXTERNAL_ANALYSIS_URL=https://source-video-analysis.onrender.com`

Kod bu değer yoksa aynı URL'yi varsayılan olarak kullanır.

## Gerçek analiz cevabı formatı

`POST /analyze` başarılı olduğunda beklenen örnek:

```json
{
  "videoDuration": 190.12,
  "mainMaleTrackId": "MAIN_MALE_01",
  "videoPrompt": "...",
  "semanticVideoMap": [],
  "actions": [
    {
      "actionId": "ACTION_001",
      "subjectTrackId": "MAIN_MALE_01",
      "label": "Ayağa kalk",
      "startTime": 12.18,
      "endTime": 13.55,
      "beforeState": "SEATED",
      "afterState": "STANDING",
      "confidence": 0.96,
      "sourceVerified": true
    }
  ]
}
```

Sadece `sourceVerified: true` olan ve geçerli start/end zamanına sahip action'lar gameplay choice olur.

## Not

Bu sürüm kasıtlı olarak hareket analizi modeli içermez. Analiz modeli `source-video-analysis` servisinde ayrı tutulur. Böylece frontend hiçbir zaman MMPose/MMAction2/ByteTrack kurulmuş gibi davranmaz.
