<?php
/**
 * Plugin Name: Brinda Agent API
 * Description: REST API endpoints for the WordPress AI Agent (Railway → WP Engine over HTTPS)
 * Version: 2.1
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
