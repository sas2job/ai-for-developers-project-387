require "test_helper"

class ApplicationSystemTestCase < ActionDispatch::SystemTestCase
  Capybara.save_path = ENV["BROWSER_EVIDENCE_DIR"] if ENV["BROWSER_EVIDENCE_DIR"].present?

  driven_by :selenium, using: :headless_chrome, screen_size: [ 1400, 1400 ] do |options|
    options.add_argument("--no-sandbox") if ENV["GITHUB_ACTIONS"] == "true"
  end

  def before_teardown
    take_screenshot if ENV["BROWSER_EVIDENCE_DIR"].present? && passed?
  ensure
    super
  end
end
