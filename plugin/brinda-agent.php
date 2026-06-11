<?php
/**
 * Plugin Name: Brinda Agent API
 * Description: REST API endpoints for the WordPress AI Agent (Railway → WP Engine over HTTPS)
 * Version: 2.2
 * Author: Brinda AI Agent
 */

if (!defined('ABSPATH')) exit;

// ── Auth: shared secret token ─────────────────────────────────────────────────
// Store the token in WP options (set once via WP Admin → Tools or via this plugin's init).
// The Railway agent sends it as: X-Agent-Token: <token>
// To set the token: add  define('BRINDA_AGENT_TOKEN', 'your-secret-here');  to wp-config.php
// OR the plugin auto-generates one on first activation and stores it in wp_options.

function brinda_get_token() {
  if (defined('BRINDA_AGENT_TOKEN')) return BRINDA_AGENT_TOKEN;
  $token = get_option('brinda_agent_token');
  if (!$token) {
    $token = bin2hex(random_bytes(24));
    update_option('brinda_agent_token', $token);
  }
  return $token;
}

function brinda_auth(WP_REST_Request $request) {
  $sent = $request->get_header('X-Agent-Token');
  if (!$sent) $sent = $request->get_param('agent_token'); // fallback query param
  if ($sent && hash_equals(brinda_get_token(), $sent)) return true;
  return new WP_Error('unauthorized', 'Invalid agent token', ['status' => 401]);
}

// ── Show token in WP Admin (Tools menu) ───────────────────────────────────────
add_action('admin_menu', function () {
  add_management_page('Agent Token', 'Agent Token', 'manage_options', 'brinda-agent-token', function () {
    $token = brinda_get_token();
    echo '<div class="wrap"><h1>Brinda Agent Token</h1>';
    echo '<p>Copy this token into your Railway <code>AGENT_TOKEN</code> environment variable:</p>';
    echo '<code style="font-size:1.2em;background:#f0f0f0;padding:8px 12px;display:block;word-break:break-all">' . esc_html($token) . '</code>';
    echo '<p><a href="' . admin_url('tools.php?page=brinda-agent-token&regenerate=1') . '" onclick="return confirm(\'Regenerate token? Update Railway env var after.\')">Regenerate token</a></p>';
    if (isset($_GET['regenerate'])) {
      $new = bin2hex(random_bytes(24));
      update_option('brinda_agent_token', $new);
      echo '<p style="color:green">✅ Token regenerated. Update Railway AGENT_TOKEN env var.</p>';
    }
    echo '</div>';
  });
});

add_action('rest_api_init', function () {

  // ══════════════════════════════════════════════════════════════════════════
  // GET /wp-json/brinda-agent/v1/site-info
  // ══════════════════════════════════════════════════════════════════════════
  register_rest_route('brinda-agent/v1', '/site-info', [
    'methods'             => 'GET',
    'callback'            => 'brinda_site_info',
    'permission_callback' => 'brinda_auth',
  ]);

  // ══════════════════════════════════════════════════════════════════════════
  // GET /wp-json/brinda-agent/v1/elementor-data?post_id=123
  // ══════════════════════════════════════════════════════════════════════════
  register_rest_route('brinda-agent/v1', '/elementor-data', [
    'methods'             => 'GET',
    'callback'            => 'brinda_get_elementor_data',
    'permission_callback' => 'brinda_auth',
  ]);

  // ══════════════════════════════════════════════════════════════════════════
  // POST /wp-json/brinda-agent/v1/elementor-data
  // ══════════════════════════════════════════════════════════════════════════
  register_rest_route('brinda-agent/v1', '/elementor-data', [
    'methods'             => 'POST',
    'callback'            => 'brinda_save_elementor_data',
    'permission_callback' => 'brinda_auth',
  ]);

  // ══════════════════════════════════════════════════════════════════════════
  // POST /wp-json/brinda-agent/v1/flush-cache
  // ══════════════════════════════════════════════════════════════════════════
  register_rest_route('brinda-agent/v1', '/flush-cache', [
    'methods'             => 'POST',
    'callback'            => 'brinda_flush_cache',
    'permission_callback' => 'brinda_auth',
  ]);

  // ══════════════════════════════════════════════════════════════════════════
  // GET /wp-json/brinda-agent/v1/cpt-posts?post_type=cpt_services&cat_id=62
  // ══════════════════════════════════════════════════════════════════════════
  register_rest_route('brinda-agent/v1', '/cpt-posts', [
    'methods'             => 'GET',
    'callback'            => 'brinda_get_cpt_posts',
    'permission_callback' => 'brinda_auth',
  ]);

  // ══════════════════════════════════════════════════════════════════════════
  // GET /wp-json/brinda-agent/v1/extended-info
  // Returns: DB schema (custom tables), plugin configs, custom code snippets
  // ══════════════════════════════════════════════════════════════════════════
  register_rest_route('brinda-agent/v1', '/extended-info', [
    'methods'             => 'GET',
    'callback'            => 'brinda_extended_info',
    'permission_callback' => 'brinda_auth',
  ]);

  // ══════════════════════════════════════════════════════════════════════════
  // GET /wp-json/brinda-agent/v1/raw-meta?post_id=123&meta_key=_elementor_data
  // Returns the raw value directly from wp_postmeta (no PHP processing).
  // Useful for debugging: see exactly what Elementor stores in the DB.
  // ══════════════════════════════════════════════════════════════════════════
  register_rest_route('brinda-agent/v1', '/raw-meta', [
    'methods'             => 'GET',
    'callback'            => 'brinda_raw_meta',
    'permission_callback' => 'brinda_auth',
  ]);

  // ══════════════════════════════════════════════════════════════════════════
  // DELETE /wp-json/brinda-agent/v1/delete-post?post_id=123
  // Works for any post type (CPT, post, page). Uses wp_delete_post() directly.
  // ══════════════════════════════════════════════════════════════════════════
  register_rest_route('brinda-agent/v1', '/delete-post', [
    'methods'             => 'DELETE',
    'callback'            => 'brinda_delete_post',
    'permission_callback' => 'brinda_auth',
  ]);

  // ══════════════════════════════════════════════════════════════════════════
  // POST /wp-json/brinda-agent/v1/create-cpt-post
  // Body: { post_type, title, excerpt, content, cat_id, featured_media_id }
  // Creates a CPT post and assigns it to the correct taxonomy term.
  // ══════════════════════════════════════════════════════════════════════════
  register_rest_route('brinda-agent/v1', '/create-cpt-post', [
    'methods'             => 'POST',
    'callback'            => 'brinda_create_cpt_post',
    'permission_callback' => 'brinda_auth',
  ]);

  // Update post/page content directly (bypasses WP REST 403 auth issues)
  register_rest_route('brinda-agent/v1', '/update-content', [
    'methods'             => 'POST',
    'callback'            => 'brinda_update_content',
    'permission_callback' => 'brinda_auth',
  ]);

  // ══════════════════════════════════════════════════════════════════════════
  // POST /wp-json/brinda-agent/v1/update-plugin
  // Updates a specific plugin (or all plugins) using WordPress upgrader API.
  // Body: { "plugin_slug": "contact-form-7" } or { "plugin_slug": "all" }
  // ══════════════════════════════════════════════════════════════════════════
  register_rest_route('brinda-agent/v1', '/update-plugin', [
    'methods'             => 'POST',
    'callback'            => 'brinda_update_plugin',
    'permission_callback' => 'brinda_auth',
  ]);

  // ══════════════════════════════════════════════════════════════════════════
  // GET /wp-json/brinda-agent/v1/plugin-list
  // Returns all installed plugins with name, version, status, update available
  // ══════════════════════════════════════════════════════════════════════════
  register_rest_route('brinda-agent/v1', '/plugin-list', [
    'methods'             => 'GET',
    'callback'            => 'brinda_plugin_list',
    'permission_callback' => 'brinda_auth',
  ]);
});

// ── /site-info ─────────────────────────────────────────────────────────────
function brinda_site_info() {
  $front_page_id = (int) get_option('page_on_front');
  $blog_page_id  = (int) get_option('page_for_posts');

  $raw_pages = get_posts([
    'post_type'      => 'page',
    'post_status'    => ['publish', 'draft'],
    'posts_per_page' => -1,
  ]);
  $pages = array_map(function($p) use ($front_page_id) {
    return [
      'id'             => $p->ID,
      'title'          => $p->post_title,
      'slug'           => $p->post_name,
      'status'         => $p->post_status,
      'template'       => get_post_meta($p->ID, '_wp_page_template', true) ?: 'default',
      'uses_elementor' => get_post_meta($p->ID, '_elementor_edit_mode', true) === 'builder',
      'is_front_page'  => $p->ID === $front_page_id,
    ];
  }, $raw_pages);

  $elementor_pages = array_values(array_filter($pages, function($p) { return $p['uses_elementor']; }));

  $raw_posts = get_posts(['post_type' => 'post', 'post_status' => 'publish', 'posts_per_page' => 30]);
  $posts = array_map(function($p) {
    return ['id' => $p->ID, 'title' => $p->post_title, 'slug' => $p->post_name, 'date' => $p->post_date];
  }, $raw_posts);

  $nav_menus = wp_get_nav_menus();
  $menus = [];
  foreach ($nav_menus as $menu) {
    $items = wp_get_nav_menu_items($menu->term_id) ?: [];
    $menus[] = [
      'id'    => $menu->term_id,
      'name'  => $menu->name,
      'slug'  => $menu->slug,
      'items' => array_map(function($i) {
        return [
          'id'        => $i->ID,
          'title'     => $i->title,
          'url'       => $i->url,
          'type'      => $i->object,
          'object_id' => (int) $i->object_id,
          'parent_id' => (int) $i->menu_item_parent ?: null,
        ];
      }, $items),
    ];
  }

  $all_plugins    = get_plugins();
  $active_plugins = get_option('active_plugins', []);
  $plugins = [];
  foreach ($all_plugins as $slug => $data) {
    $plugins[] = [
      'slug'    => $slug,
      'title'   => $data['Name'],
      'version' => $data['Version'],
      'status'  => in_array($slug, $active_plugins) ? 'active' : 'inactive',
    ];
  }

  $cpts = get_post_types(['public' => true, '_builtin' => false], 'objects');
  $custom_post_types = array_values(array_map(function($cpt) {
    // Include taxonomies and their terms so agent knows available categories
    $taxonomies = get_object_taxonomies($cpt->name, 'objects');
    $tax_info = [];
    foreach ($taxonomies as $tax) {
      $terms = get_terms(['taxonomy' => $tax->name, 'hide_empty' => false]);
      $tax_info[] = [
        'slug'  => $tax->name,
        'label' => $tax->label,
        'terms' => is_array($terms) ? array_map(function($t) {
          return ['id' => $t->term_id, 'name' => $t->name, 'slug' => $t->slug, 'count' => $t->count];
        }, $terms) : [],
      ];
    }
    return [
      'slug'       => $cpt->name,
      'label'      => $cpt->label,
      'taxonomies' => $tax_info,
    ];
  }, $cpts));

  return rest_ensure_response([
    'generated_at'      => current_time('c'),
    'site'              => ['blogname' => get_bloginfo('name'), 'siteurl' => get_bloginfo('url')],
    'front_page_id'     => $front_page_id ?: null,
    'blog_page_id'      => $blog_page_id  ?: null,
    'theme'             => ['child' => get_stylesheet(), 'parent' => get_template()],
    'pages'             => $pages,
    'elementor_pages'   => $elementor_pages,
    'posts'             => $posts,
    'menus'             => $menus,
    'plugins'           => $plugins,
    'custom_post_types' => $custom_post_types,
  ]);
}

// ── /elementor-data GET ────────────────────────────────────────────────────
function brinda_get_elementor_data(WP_REST_Request $request) {
  $post_id = (int) $request->get_param('post_id');
  if (!$post_id) return new WP_Error('missing_param', 'post_id required', ['status' => 400]);
  return rest_ensure_response([
    'post_id'        => $post_id,
    'elementor_data' => get_post_meta($post_id, '_elementor_data', true) ?: '',
  ]);
}

// ── /elementor-data POST ───────────────────────────────────────────────────
function brinda_save_elementor_data(WP_REST_Request $request) {
  $post_id        = (int) $request->get_param('post_id');
  $elementor_data = $request->get_param('elementor_data');
  if (!$post_id)        return new WP_Error('missing_param', 'post_id required',        ['status' => 400]);
  if (!$elementor_data) return new WP_Error('missing_param', 'elementor_data required', ['status' => 400]);

  update_post_meta($post_id, '_elementor_data', wp_slash($elementor_data));
  delete_post_meta($post_id, '_elementor_css');
  delete_post_meta($post_id, '_elementor_element_cache');
  delete_post_meta($post_id, '_elementor_page_assets');

  if (class_exists('\Elementor\Plugin')) {
    try { \Elementor\Plugin::$instance->files_manager->clear_cache(); } catch (\Throwable $e) {}
    try { \Elementor\Plugin::$instance->posts_css_manager->clear_cache(); } catch (\Throwable $e) {}
  }
  wp_cache_flush();
  return rest_ensure_response(['success' => true, 'post_id' => $post_id]);
}

// ── /flush-cache POST ──────────────────────────────────────────────────────
function brinda_flush_cache(WP_REST_Request $request) {
  $post_id = (int) $request->get_param('post_id');
  if ($post_id) {
    delete_post_meta($post_id, '_elementor_css');
    delete_post_meta($post_id, '_elementor_element_cache');
    delete_post_meta($post_id, '_elementor_page_assets');
  }
  if (class_exists('\Elementor\Plugin')) {
    try { \Elementor\Plugin::$instance->files_manager->clear_cache(); } catch (\Throwable $e) {}
  }
  wp_cache_flush();
  if (function_exists('wpecommon_purge_varnish_cache_all')) wpecommon_purge_varnish_cache_all();
  return rest_ensure_response(['success' => true]);
}

// ── /extended-info GET ────────────────────────────────────────────────────
function brinda_extended_info() {
  global $wpdb;

  // ── 1. DATABASE SCHEMA ────────────────────────────────────────────────────
  // All tables in the DB, flagged as core WP, plugin-added, or custom
  $core_tables = [
    'commentmeta','comments','links','options','postmeta','posts',
    'term_relationships','term_taxonomy','termmeta','terms','usermeta','users',
  ];
  $all_tables = $wpdb->get_col('SHOW TABLES');
  $db_schema = [];
  foreach ($all_tables as $table) {
    $bare = str_replace($wpdb->prefix, '', $table);
    $is_core = in_array($bare, $core_tables);

    // Get column info for every table (skip large core tables to keep response lean)
    $columns = [];
    if (!$is_core || in_array($bare, ['options', 'postmeta', 'usermeta'])) {
      $cols = $wpdb->get_results("DESCRIBE `{$table}`");
      foreach ($cols as $col) {
        $columns[] = [
          'name' => $col->Field,
          'type' => $col->Type,
          'null' => $col->Null,
          'key'  => $col->Key,
        ];
      }
    }

    $db_schema[] = [
      'table'    => $table,
      'bare'     => $bare,
      'is_core'  => $is_core,
      'columns'  => $columns,
    ];
  }

  // ── 2. PLUGIN CONFIGURATIONS ──────────────────────────────────────────────
  // Known option keys per plugin — expand this list as needed
  $plugin_option_map = [
    'elementor'              => ['elementor_experiment-container','elementor_css_print_method','elementor_global_images_lightbox','elementor_default_generic_fonts','elementor_active_kit','elementor_version'],
    'woocommerce'            => ['woocommerce_store_address','woocommerce_currency','woocommerce_currency_pos','woocommerce_price_decimal_sep','woocommerce_checkout_page_id','woocommerce_cart_page_id','woocommerce_shop_page_id','woocommerce_enable_guest_checkout','woocommerce_enable_signup_and_login_from_checkout','woocommerce_registration_generate_password'],
    'yoast-seo'              => ['wpseo','wpseo_titles','wpseo_social'],
    'contact-form-7'         => ['wpcf7'],
    'the-events-calendar'    => ['tribe_events_calendar_options'],
    'give'                   => ['give_settings'],
    'smash-balloon-instagram'=> ['sb_instagram_settings'],
    'wp-engine'              => ['wpe_custom_login_url','wpe_default_cdn'],
    'timetable'              => ['timetable_settings','timetable_options'],
    'slider-revolution'      => [],  // no single options key
  ];

  $plugin_configs = [];
  $active_plugins = get_option('active_plugins', []);
  foreach ($active_plugins as $plugin_file) {
    $slug = explode('/', $plugin_file)[0];
    $options_to_read = $plugin_option_map[$slug] ?? [];

    // Auto-detect option keys containing the plugin slug if not in map
    if (empty($options_to_read)) {
      $slug_clean = str_replace(['-','_'], '%', $slug);
      $auto = $wpdb->get_col(
        $wpdb->prepare("SELECT option_name FROM {$wpdb->options} WHERE option_name LIKE %s LIMIT 5", "%{$slug_clean}%")
      );
      $options_to_read = $auto;
    }

    $config = [];
    foreach ($options_to_read as $opt_key) {
      $val = get_option($opt_key);
      if ($val !== false) {
        // Truncate large arrays/objects to avoid huge payloads
        $encoded = json_encode($val);
        $config[$opt_key] = strlen($encoded) > 2000
          ? json_decode(substr($encoded, 0, 2000)) // truncate
          : $val;
      }
    }

    if (!empty($config)) {
      $plugin_data = get_plugins()[$plugin_file] ?? [];
      $plugin_configs[] = [
        'slug'    => $slug,
        'name'    => $plugin_data['Name'] ?? $slug,
        'version' => $plugin_data['Version'] ?? '',
        'config'  => $config,
      ];
    }
  }

  // ── 3. CUSTOM CODE ────────────────────────────────────────────────────────
  $custom_code = [];

  // Child theme functions.php
  $child_functions = get_stylesheet_directory() . '/functions.php';
  if (file_exists($child_functions)) {
    $content = file_get_contents($child_functions);
    $custom_code['child_theme_functions'] = [
      'file'    => $child_functions,
      'lines'   => substr_count($content, "\n"),
      'content' => substr($content, 0, 8000), // first 8KB
      'truncated' => strlen($content) > 8000,
    ];
  }

  // Child theme style.css (contains theme metadata)
  $child_style = get_stylesheet_directory() . '/style.css';
  if (file_exists($child_style)) {
    $content = file_get_contents($child_style);
    $custom_code['child_theme_style'] = [
      'file'    => $child_style,
      'lines'   => substr_count($content, "\n"),
      'content' => substr($content, 0, 3000),
      'truncated' => strlen($content) > 3000,
    ];
  }

  // Custom plugins (not from wp.org — directories in wp-content/plugins without readme.txt)
  $plugins_dir = WP_PLUGIN_DIR;
  $custom_plugins = [];
  foreach (glob($plugins_dir . '/*/') as $dir) {
    $plugin_slug = basename($dir);
    // Skip known repo plugins — if no changelog/readme it might be custom
    $is_custom = !file_exists($dir . 'readme.txt') && !file_exists($dir . 'README.txt');
    if ($is_custom) {
      // Find the main plugin file
      foreach (glob($dir . '*.php') as $php_file) {
        $header = file_get_contents($php_file, false, null, 0, 1000);
        if (strpos($header, 'Plugin Name:') !== false) {
          $custom_plugins[] = [
            'slug'    => $plugin_slug,
            'file'    => basename($php_file),
            'content' => substr(file_get_contents($php_file), 0, 5000),
            'truncated' => filesize($php_file) > 5000,
          ];
          break;
        }
      }
    }
  }
  if ($custom_plugins) $custom_code['custom_plugins'] = $custom_plugins;

  // Active must-use plugins (wp-content/mu-plugins)
  $mu_dir = WPMU_PLUGIN_DIR;
  $mu_plugins = [];
  if (is_dir($mu_dir)) {
    foreach (glob($mu_dir . '/*.php') as $mu_file) {
      $content = file_get_contents($mu_file);
      $mu_plugins[] = [
        'file'      => basename($mu_file),
        'content'   => substr($content, 0, 3000),
        'truncated' => strlen($content) > 3000,
      ];
    }
  }
  if ($mu_plugins) $custom_code['mu_plugins'] = $mu_plugins;

  // WooCommerce custom hooks / shortcodes registered in functions.php
  // (surface any add_action / add_filter / add_shortcode calls from child theme)
  if (isset($custom_code['child_theme_functions'])) {
    $fc = $custom_code['child_theme_functions']['content'];
    preg_match_all('/add_(action|filter|shortcode)\s*\(\s*[\'"]([^\'"]+)[\'"]/', $fc, $hooks);
    if (!empty($hooks[2])) {
      $custom_code['registered_hooks'] = array_map(null, $hooks[1], $hooks[2]);
    }
  }

  return rest_ensure_response([
    'db_schema'      => $db_schema,
    'plugin_configs' => $plugin_configs,
    'custom_code'    => $custom_code,
  ]);
}

// ── /raw-meta GET ─────────────────────────────────────────────────────────
// Returns the raw wp_postmeta value straight from the DB — no unserializing,
// no Elementor processing. Use for debugging what's actually stored.
function brinda_raw_meta(WP_REST_Request $request) {
  global $wpdb;
  $post_id  = (int) $request->get_param('post_id');
  $meta_key = $request->get_param('meta_key') ?: '_elementor_data';
  if (!$post_id) return new WP_Error('missing_param', 'post_id required', ['status' => 400]);

  // Query raw from DB — bypasses all WP caching and processing
  $raw = $wpdb->get_var($wpdb->prepare(
    "SELECT meta_value FROM {$wpdb->postmeta} WHERE post_id = %d AND meta_key = %s LIMIT 1",
    $post_id, $meta_key
  ));

  if ($raw === null) {
    return new WP_Error('not_found', "No meta found for post_id={$post_id} meta_key={$meta_key}", ['status' => 404]);
  }

  // Try to decode if JSON, otherwise return raw string
  $decoded = json_decode($raw, true);
  $is_json = (json_last_error() === JSON_ERROR_NONE);

  // If it's _elementor_data, extract widget settings for quick inspection
  $widget_summary = [];
  if ($is_json && $meta_key === '_elementor_data') {
    $stack = $decoded;
    while (!empty($stack)) {
      $node = array_shift($stack);
      if (($node['elType'] ?? '') === 'widget') {
        $wt = $node['widgetType'] ?? 'unknown';
        $s  = $node['settings'] ?? [];
        $widget_summary[] = [
          'widgetType' => $wt,
          'settings'   => $s,
        ];
      }
      foreach (($node['elements'] ?? []) as $child) {
        array_unshift($stack, $child);
      }
    }
  }

  return rest_ensure_response([
    'post_id'        => $post_id,
    'meta_key'       => $meta_key,
    'raw_length'     => strlen($raw),
    'is_json'        => $is_json,
    'raw_value'      => $is_json ? null : $raw,          // only for non-JSON meta
    'parsed'         => $is_json ? $decoded : null,       // full parsed JSON
    'widget_summary' => $widget_summary,                  // quick widget settings view
  ]);
}

// ── /delete-post DELETE ───────────────────────────────────────────────────
function brinda_delete_post(WP_REST_Request $request) {
  $post_id = (int) $request->get_param('post_id');
  if (!$post_id) return new WP_Error('missing_param', 'post_id required', ['status' => 400]);

  $post = get_post($post_id);
  if (!$post) return new WP_Error('not_found', "Post {$post_id} not found", ['status' => 404]);

  $result = wp_delete_post($post_id, true); // true = force delete, bypass trash
  if (!$result) return new WP_Error('delete_failed', "Could not delete post {$post_id}", ['status' => 500]);

  return rest_ensure_response([
    'deleted' => true,
    'post_id' => $post_id,
    'post_type' => $post->post_type,
    'title'   => $post->post_title,
  ]);
}

// ── /create-cpt-post POST ─────────────────────────────────────────────────
function brinda_create_cpt_post(WP_REST_Request $request) {
  $post_type         = sanitize_key($request->get_param('post_type') ?: 'cpt_services');
  $title             = sanitize_text_field($request->get_param('title') ?: '');
  $excerpt           = sanitize_textarea_field($request->get_param('excerpt') ?: '');
  $content           = wp_kses_post($request->get_param('content') ?: '');
  $cat_id            = (int) $request->get_param('cat_id');
  $featured_media_id = (int) $request->get_param('featured_media_id');

  if (!$title) return new WP_Error('missing_param', 'title required', ['status' => 400]);

  // Insert the post
  $post_id = wp_insert_post([
    'post_type'    => $post_type,
    'post_status'  => 'publish',
    'post_title'   => $title,
    'post_excerpt' => $excerpt,
    'post_content' => $content,
  ], true);

  if (is_wp_error($post_id)) {
    return new WP_Error('insert_failed', $post_id->get_error_message(), ['status' => 500]);
  }

  // Assign taxonomy term (convention: post_type + '_group', e.g. cpt_services_group)
  if ($cat_id) {
    $taxonomy = $post_type . '_group';
    if (taxonomy_exists($taxonomy)) {
      wp_set_object_terms($post_id, $cat_id, $taxonomy);
    }
  }

  // Set featured image
  if ($featured_media_id) {
    set_post_thumbnail($post_id, $featured_media_id);
  }

  $post = get_post($post_id);
  return rest_ensure_response([
    'id'     => $post_id,
    'title'  => $post->post_title,
    'status' => $post->post_status,
    'link'   => get_permalink($post_id),
  ]);
}

// ── /cpt-posts GET ─────────────────────────────────────────────────────────
function brinda_get_cpt_posts(WP_REST_Request $request) {
  $post_type = sanitize_key($request->get_param('post_type') ?: 'cpt_services');
  $cat_id    = (int) $request->get_param('cat_id');
  $args = ['post_type' => $post_type, 'post_status' => 'publish', 'posts_per_page' => -1];
  if ($cat_id) {
    $args['tax_query'] = [['taxonomy' => $post_type . '_group', 'field' => 'term_id', 'terms' => $cat_id]];
  }
  $raw = get_posts($args);
  return rest_ensure_response([
    'post_type' => $post_type,
    'cat_id'    => $cat_id,
    'count'     => count($raw),
    'posts'     => array_map(function($p) {
      return ['id' => $p->ID, 'title' => $p->post_title, 'status' => $p->post_status, 'slug' => $p->post_name];
    }, $raw),
  ]);
}

// ── /update-content ──────────────────────────────────────────────────────────
// Direct post/page content update bypassing WP REST API auth restrictions.
// Accepts: { post_id, fields: { title?, content?, status? } }
function brinda_update_content(WP_REST_Request $request) {
  $post_id = (int) $request->get_param("post_id");
  $fields  = $request->get_param("fields") ?: [];

  if (!$post_id) {
    return new WP_Error("missing_post_id", "post_id is required", ["status" => 400]);
  }

  $post = get_post($post_id);
  if (!$post) {
    return new WP_Error("not_found", "Post $post_id not found", ["status" => 404]);
  }

  $update = ["ID" => $post_id];
  if (!empty($fields["title"]))   $update["post_title"]   = sanitize_text_field($fields["title"]);
  if (!empty($fields["content"])) $update["post_content"] = wp_kses_post($fields["content"]);
  if (!empty($fields["status"]))  $update["post_status"]  = sanitize_key($fields["status"]);

  $result = wp_update_post($update, true);
  if (is_wp_error($result)) {
    return new WP_Error("update_failed", $result->get_error_message(), ["status" => 500]);
  }

  return rest_ensure_response([
    "success"  => true,
    "post_id"  => $post_id,
    "updated"  => array_keys($update),
    "post_type"=> $post->post_type,
  ]);
}

// ── /plugin-list ────────────────────────────────────────────────────────────
function brinda_plugin_list() {
  if (!function_exists('get_plugins')) {
    require_once ABSPATH . 'wp-admin/includes/plugin.php';
  }
  if (!function_exists('get_plugin_updates')) {
    require_once ABSPATH . 'wp-admin/includes/update.php';
  }

  $all_plugins    = get_plugins();
  $active_plugins = get_option('active_plugins', []);
  wp_update_plugins(); // refresh update transient
  $updates = get_plugin_updates();

  $result = [];
  foreach ($all_plugins as $file => $data) {
    $slug = explode('/', $file)[0];
    $result[] = [
      'file'             => $file,
      'slug'             => $slug,
      'name'             => $data['Name'],
      'version'          => $data['Version'],
      'status'           => in_array($file, $active_plugins) ? 'active' : 'inactive',
      'update_available' => isset($updates[$file]),
      'new_version'      => isset($updates[$file]) ? $updates[$file]->update->new_version : null,
    ];
  }

  return rest_ensure_response(['plugins' => $result, 'count' => count($result)]);
}

// ── /update-plugin ──────────────────────────────────────────────────────────
function brinda_update_plugin(WP_REST_Request $request) {
  $plugin_slug = sanitize_text_field($request->get_param('plugin_slug'));
  if (!$plugin_slug) {
    return new WP_Error('missing_param', 'plugin_slug is required', ['status' => 400]);
  }

  // Load required WP upgrader classes
  require_once ABSPATH . 'wp-admin/includes/class-wp-upgrader.php';
  require_once ABSPATH . 'wp-admin/includes/class-automatic-upgrader-skin.php';
  require_once ABSPATH . 'wp-admin/includes/plugin.php';
  require_once ABSPATH . 'wp-admin/includes/update.php';

  if (!function_exists('get_plugins')) require_once ABSPATH . 'wp-admin/includes/plugin.php';

  wp_update_plugins(); // refresh available updates
  $updates = get_plugin_updates();

  if ($plugin_slug === 'all') {
    // Update all plugins with available updates
    $updated  = [];
    $skipped  = [];
    $failed   = [];

    foreach ($updates as $file => $data) {
      $skin     = new Automatic_Upgrader_Skin();
      $upgrader = new Plugin_Upgrader($skin);
      $result   = $upgrader->upgrade($file);
      if (is_wp_error($result)) {
        $failed[] = $file;
      } elseif ($result === false) {
        $skipped[] = $file; // already up to date
      } else {
        $updated[] = ['file' => $file, 'new_version' => $data->update->new_version ?? 'latest'];
      }
    }

    return rest_ensure_response([
      'success' => true,
      'target'  => 'all',
      'updated' => $updated,
      'skipped' => $skipped,
      'failed'  => $failed,
      'update_count' => count($updated),
    ]);
  }

  // Find the plugin file for this slug
  $all_plugins = get_plugins();
  $plugin_file = null;
  foreach ($all_plugins as $file => $data) {
    if (explode('/', $file)[0] === $plugin_slug || strpos($file, $plugin_slug) === 0) {
      $plugin_file = $file;
      break;
    }
  }

  if (!$plugin_file) {
    return new WP_Error('not_found', "Plugin not found: {$plugin_slug}", ['status' => 404]);
  }

  $plugin_data    = $all_plugins[$plugin_file];
  $old_version    = $plugin_data['Version'];

  // Check if update is available
  if (!isset($updates[$plugin_file])) {
    return rest_ensure_response([
      'success'   => true,
      'plugin'    => $plugin_data['Name'],
      'file'      => $plugin_file,
      'version'   => $old_version,
      'message'   => 'Plugin is already up to date',
      'updated'   => false,
    ]);
  }

  $new_version = $updates[$plugin_file]->update->new_version ?? 'latest';

  // Run the upgrade
  $skin     = new Automatic_Upgrader_Skin();
  $upgrader = new Plugin_Upgrader($skin);
  $result   = $upgrader->upgrade($plugin_file);

  if (is_wp_error($result)) {
    return new WP_Error('update_failed', $result->get_error_message(), ['status' => 500]);
  }

  return rest_ensure_response([
    'success'      => true,
    'plugin'       => $plugin_data['Name'],
    'file'         => $plugin_file,
    'old_version'  => $old_version,
    'new_version'  => $new_version,
    'updated'      => true,
    'message'      => "Updated {$plugin_data['Name']} from {$old_version} to {$new_version}",
  ]);
}
