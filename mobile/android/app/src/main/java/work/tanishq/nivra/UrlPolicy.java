package work.tanishq.nivra;

import java.net.URI;
import java.net.URISyntaxException;

/** No pairing credentials are stored here or in app preferences. */
final class UrlPolicy {
    static final String ORIGIN = "https://nivra.tanishq.work";

    static boolean trusted(String value) {
        if (value == null) return false;
        try {
            URI uri = new URI(value);
            return "https".equalsIgnoreCase(uri.getScheme())
                && "nivra.tanishq.work".equalsIgnoreCase(uri.getHost())
                && uri.getRawUserInfo() == null && (uri.getPort() == -1 || uri.getPort() == 443);
        } catch (URISyntaxException error) { return false; }
    }

    static String pairing(String value) {
        if (value == null) return null;
        try {
            URI uri = new URI(value.trim());
            String path;
            if ("nivra".equals(uri.getScheme())) {
                if (uri.getRawUserInfo() != null || uri.getPort() != -1
                    || uri.getRawQuery() != null || (uri.getPath() != null && !uri.getPath().isEmpty())) return null;
                path = "/" + uri.getHost();
            } else {
                if (!trusted(value.trim()) || uri.getRawQuery() != null) return null;
                path = uri.getRawPath();
            }
            String fragment = uri.getRawFragment();
            if (("/camera".equals(path) || "/guard".equals(path))
                && fragment != null && fragment.matches("pair=[A-Za-z0-9_-]{30,100}")) {
                return ORIGIN + path + "#" + fragment;
            }
            if ((trusted(value.trim()) || "nivra".equals(uri.getScheme()))
                && ("/".equals(path) || "/wall".equals(path))
                && fragment != null && fragment.matches("operator=[A-Za-z0-9_-]{30,100}")) {
                return ORIGIN + path + "#" + fragment;
            }
            return null;
        } catch (URISyntaxException error) { return null; }
    }

    static String withoutFragment(String value) {
        return value == null ? null : value.split("#", 2)[0];
    }
}
