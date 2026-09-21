"""Handle declarative external players omitted by VK's native player parser."""
import html
import ipaddress
import json
import re
import socket
from html.parser import HTMLParser
from urllib.parse import urljoin, urlsplit

from yt_dlp.extractor.vk import VKIE
from yt_dlp.utils import ExtractorError, clean_html


class _Frames(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.urls = []

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag in ('iframe', 'embed'):
            value = attrs.get('src') or attrs.get('data-src')
            if value:
                self.urls.append(value)


def external_players(payload, base_url):
    """Only follow a supplied player URL, never guess media or access tokens."""
    if not isinstance(payload, list) or len(payload) < 2:
        return []
    opts = payload[-1] if isinstance(payload[-1], dict) else {}
    player = opts.get('player') or {}
    texts = [payload[1]]
    urls = []
    if isinstance(player, dict):
        for key in ('html', 'code', 'iframe', 'embed'):
            texts.append(player.get(key))
        for key in ('url', 'src', 'embed_url', 'embedUrl', 'player_url', 'playerUrl'):
            if isinstance(player.get(key), str):
                urls.append(player[key])
    for value in texts:
        if not isinstance(value, str):
            continue
        parser = _Frames()
        parser.feed(html.unescape(value).replace('\\/', '/'))
        urls.extend(parser.urls)
    result = []
    for value in urls:
        if any(char in value for char in ('\r', '\n', '\0')):
            continue
        try:
            target = urljoin(base_url, html.unescape(value).replace('\\/', '/'))
            parts = urlsplit(target)
        except ValueError:
            continue
        host = (parts.hostname or '').lower()
        if parts.scheme not in ('http', 'https') or not host or parts.username or parts.password:
            continue
        if re.search(r'(^|\.)(vk\.com|vk\.ru|vkvideo\.ru)$', host):
            continue  # Do not recurse into the same broken VK player.
        if target not in result:
            result.append(target)
    return result[:3]


def _public_player(url):
    host = urlsplit(url).hostname
    if host == 'localhost' or host.endswith(('.localhost', '.local')):
        return False
    try:
        addresses = socket.getaddrinfo(host, None, type=socket.SOCK_STREAM)
        return bool(addresses) and all(ipaddress.ip_address(row[4][0]).is_global for row in addresses)
    except (OSError, ValueError):
        return False


class VKExternalEmbedIE(VKIE, plugin_name='videoquest'):
    def _download_payload(self, *args, **kwargs):
        payload = super()._download_payload(*args, **kwargs)
        self._videoquest_payload = payload
        return payload

    def _real_extract(self, url):
        self._videoquest_payload = None
        try:
            return super()._real_extract(url)
        except KeyError as error:
            if error.args != ('params',):
                raise
            payload = self._videoquest_payload
            opts = payload[-1] if isinstance(payload, list) and payload and isinstance(payload[-1], dict) else {}
            if opts.get('player_unavailable'):
                page = payload[1] if len(payload) > 1 and isinstance(payload[1], str) else ''
                message = re.search(r'''(?is)<div\b[^>]*(?:class|id)=["'][^"']*\b(?:video_layer_message|video_ext_msg|mv_error|video_error|video_unavailable)\b[^"']*["'][^>]*>(.*?)</div>''', page)
                reason = (clean_html(message.group(1)) or '')[:240] if message else ''
                # Respect a declared unavailable player instead of following
                # unrelated frames from the error page.
                raise ExtractorError('VK_PLAYER_UNAVAILABLE' + (': ' + reason if reason else ''), expected=True) from error
            for candidate in external_players(payload, url):
                if _public_player(candidate):
                    return self.url_result(candidate)
            # Keys and types only: no private link, title, token or media URL.
            player = opts.get('player') or {}
            shape = {
                'options': sorted(opts.keys())[:40],
                'player': sorted(player.keys())[:40] if isinstance(player, dict) else type(player).__name__,
                'pageType': type(payload[1]).__name__ if isinstance(payload, list) and len(payload) > 1 else 'missing',
            }
            raise ExtractorError('VK_PLAYER_METADATA_MISSING ' + json.dumps(shape), expected=True) from error
