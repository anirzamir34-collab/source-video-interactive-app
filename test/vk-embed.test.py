import importlib.util
import pathlib
import sys
import unittest
from unittest.mock import patch

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'node_modules/youtube-dl-exec/bin/yt-dlp'))
spec = importlib.util.spec_from_file_location('vk_embed_test_module', ROOT / 'extractor-plugins/videoquest/yt_dlp_plugins/extractor/vk_embed.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
from yt_dlp import YoutubeDL


class VKEmbedTests(unittest.TestCase):
    def test_external_iframe_and_player_configuration(self):
        payload = [None, '<iframe data-src="//player.example/embed?id=1&amp;key=2"></iframe>', {'player': {'url': 'https://player.example/other'}}]
        self.assertEqual(module.external_players(payload, 'https://vk.com/video-1_2'), [
            'https://player.example/other', 'https://player.example/embed?id=1&key=2'])

    def test_no_scripts_credentials_or_recursive_vk_players(self):
        payload = [None, '<script src="https://ads.example/ad.js"></script><iframe src="javascript:alert(1)"></iframe>', {'player': {'url': 'https://user:secret@player.example/embed', 'src': 'https://m.vkvideo.ru/video-1_2'}}]
        self.assertEqual(module.external_players(payload, 'https://vk.com/video-1_2'), [])

    def test_no_guessed_external_source(self):
        self.assertEqual(module.external_players([None, '<a href="https://player.example/watch">unrelated</a>', {'mvData': {'url': 'https://player.example/unrelated'}}], 'https://vk.com/video-1_2'), [])

    def test_private_and_mixed_dns_addresses_rejected(self):
        self.assertFalse(module._public_player('http://localhost/embed'))
        with patch.object(module.socket, 'getaddrinfo', return_value=[(None, None, None, None, ('127.0.0.1', 80))]):
            self.assertFalse(module._public_player('https://player.example/embed'))

    def test_native_formats_unchanged(self):
        with patch.object(module.VKIE, '_real_extract', return_value={'formats': [{'url': 'https://cdn.example/a.mp4'}]}):
            self.assertIn('formats', module.VKExternalEmbedIE()._real_extract('https://vk.com/video-1_2'))

    def test_vk_html5_payload_without_params_preserves_sources_quality_and_referer(self):
        def native(instance, url):
            instance._videoquest_payload = [None, '<div><video poster="https://img.example/poster.jpg"><source src="https://cdn.example/720.mp4?key=test&amp;v=2" type="video/mp4" label="720p"><source src="https://cdn.example/1080.mp4" type="video/mp4" label="1080p"></video></div>', {'is_vk_player': True, 'player_unavailable': False, 'mvData': {'title': 'Example video', 'duration': 120}}]
            raise KeyError('params')
        with patch.object(module.VKIE, '_real_extract', native), YoutubeDL({'quiet': True}) as downloader:
            result = module.VKExternalEmbedIE(downloader)._real_extract('https://vk.com/video-1_2?list=ln-example')
            self.assertEqual(result['id'], '-1_2')
            self.assertEqual(result['title'], 'Example video')
            self.assertEqual(result['duration'], 120)
            self.assertEqual([f['height'] for f in result['formats']], [720, 1080])
            self.assertEqual(result['formats'][0]['url'], 'https://cdn.example/720.mp4?key=test&v=2')
            self.assertEqual(result['formats'][1]['http_headers']['Referer'], 'https://vk.com/video-1_2?list=ln-example')

    def test_missing_params_follows_only_returned_public_player(self):
        def native(instance, url):
            instance._videoquest_payload = [None, '<iframe src="https://player.example/embed"></iframe>', {}]
            raise KeyError('params')
        with patch.object(module.VKIE, '_real_extract', native), patch.object(module, '_public_player', return_value=True):
            result = module.VKExternalEmbedIE()._real_extract('https://vk.com/video-1_2')
            self.assertEqual(result['url'], 'https://player.example/embed')

    def test_login_error_is_not_bypassed(self):
        with patch.object(module.VKIE, '_real_extract', side_effect=module.ExtractorError('Login required', expected=True)):
            with self.assertRaisesRegex(module.ExtractorError, 'Login required'):
                module.VKExternalEmbedIE()._real_extract('https://vk.com/video-1_2')

    def test_unavailable_flag_preserves_source_error_and_ignores_other_frames(self):
        def native(instance, url):
            instance._videoquest_payload = [None, '<div class="video_layer_message">Video is not available</div><iframe src="https://ads.example/embed"></iframe>', {'player_unavailable': True}]
            raise KeyError('params')
        with patch.object(module.VKIE, '_real_extract', native), patch.object(module, '_public_player') as public:
            with self.assertRaisesRegex(module.ExtractorError, 'VK_PLAYER_UNAVAILABLE: Video is not available'):
                module.VKExternalEmbedIE()._real_extract('https://vk.com/video-1_2')
            public.assert_not_called()

    def test_malformed_frame_does_not_hide_a_valid_sibling(self):
        payload = [None, '<iframe src="https://[invalid"></iframe><iframe src="https://player.example/embed"></iframe>', {}]
        self.assertEqual(module.external_players(payload, 'https://vk.com/video-1_2'), ['https://player.example/embed'])

    def test_diagnostic_has_structure_without_private_values(self):
        def native(instance, url):
            instance._videoquest_payload = [None, '', {'player': {'secret': 'PRIVATE'}, 'mvData': {'title': 'PRIVATE'}}]
            raise KeyError('params')
        with patch.object(module.VKIE, '_real_extract', native):
            with self.assertRaises(module.ExtractorError) as caught:
                module.VKExternalEmbedIE()._real_extract('https://vk.com/video-1_2?list=PRIVATE')
            self.assertIn('VK_PLAYER_METADATA_MISSING', str(caught.exception))
            self.assertNotIn('PRIVATE', str(caught.exception))


if __name__ == '__main__':
    unittest.main()
